export const HEADER_POLICY_VERSION = 'http-header-policy-v1';

export const RECOMMENDED_REFERRER_POLICY = 'strict-origin-when-cross-origin';
export const HSTS_MINIMUM_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;
export const COMPRESSION_MINIMUM_BODY_BYTES = 4 * 1024;

const VALID_REFERRER_POLICIES = new Set([
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url'
]);
const UNSAFE_REFERRER_POLICIES = new Set(['unsafe-url', 'no-referrer-when-downgrade']);
const SENSITIVE_PERMISSION_FEATURES = new Set([
  'camera',
  'geolocation',
  'microphone',
  'payment',
  'usb'
]);

export function normalizedHeaderBag(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = String(rawKey || '').trim().toLowerCase();
    if (!key || rawValue === null || rawValue === undefined) continue;
    output[key] = Array.isArray(rawValue)
      ? rawValue.map((entry) => String(entry).trim()).filter(Boolean)
      : String(rawValue).trim();
  }
  return output;
}

export function headerValues(headers, name) {
  const value = normalizedHeaderBag(headers)[String(name || '').toLowerCase()];
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

export function parseContentSecurityPolicy(headers) {
  const enforcedValues = headerValues(headers, 'content-security-policy');
  const reportOnlyValues = headerValues(headers, 'content-security-policy-report-only');
  const enforced = enforcedValues.flatMap(splitCombinedCsp).map(parseCspPolicy);
  const reportOnly = reportOnlyValues.flatMap(splitCombinedCsp).map(parseCspPolicy);
  const errors = enforced.flatMap((policy) => policy.errors);
  const frameAncestors = enforced.flatMap((policy) => policy.directives['frame-ancestors'] || []);

  if (!enforced.length) {
    return policyResult(reportOnly.length ? 'report_only' : 'missing', {
      severity: 'Low',
      reason: reportOnly.length
        ? 'Only Content-Security-Policy-Report-Only is present.'
        : 'Content-Security-Policy is missing.',
      enforced,
      reportOnly,
      frameAncestors
    });
  }
  if (errors.length) {
    return policyResult('invalid', {
      severity: 'Low',
      reason: 'At least one enforced CSP value contains invalid or unusable syntax.',
      enforced,
      reportOnly,
      errors,
      frameAncestors
    });
  }

  const hasResourceProtection = enforced.some((policy) =>
    ['default-src', 'script-src', 'object-src', 'style-src', 'img-src', 'connect-src']
      .some((directive) => Object.hasOwn(policy.directives, directive))
  );
  if (!hasResourceProtection) {
    return policyResult('incomplete_protection', {
      severity: 'Low',
      reason: 'The enforced CSP contains no resource-loading protection; report-only policies do not complete enforcement.',
      enforced,
      reportOnly,
      frameAncestors
    });
  }

  const severeWeaknesses = enforced.flatMap(cspSevereWeaknesses);
  if (severeWeaknesses.length) {
    return policyResult('dangerously_weak', {
      severity: 'Medium',
      reason: 'The enforced CSP is materially weakened by broadly permissive executable-content rules.',
      enforced,
      reportOnly,
      severeWeaknesses,
      frameAncestors
    });
  }

  return policyResult('protected', {
    severity: 'Info',
    reason: 'A syntactically usable enforced CSP is present.',
    pass: true,
    enforced,
    reportOnly,
    frameAncestors,
    qualitySignals: enforced.flatMap(cspQualitySignals)
  });
}

export function parsePermissionsPolicy(headers) {
  const values = headerValues(headers, 'permissions-policy');
  if (!values.length) return policyResult('missing', {
    severity: 'Low',
    reason: 'Permissions-Policy is missing.',
    directives: []
  });

  const directives = [];
  const errors = [];
  for (const value of values) {
    for (const rawDirective of splitOutsideParentheses(value, ',')) {
      const match = rawDirective.trim().match(/^([a-z][a-z0-9-]*)\s*=\s*\((.*)\)$/i);
      if (!match) {
        errors.push({ directive: rawDirective.trim(), reason: 'invalid_directive_syntax' });
        continue;
      }
      const feature = match[1].toLowerCase();
      const allowlist = tokenizeAllowlist(match[2]);
      if (!allowlist.valid) {
        errors.push({ directive: rawDirective.trim(), feature, reason: allowlist.reason });
        continue;
      }
      directives.push({ feature, allowlist: allowlist.tokens });
    }
  }
  if (errors.length || !directives.length) return policyResult('invalid', {
    severity: 'Low',
    reason: 'Permissions-Policy contains invalid or empty directives.',
    directives,
    errors
  });

  const dangerouslyOpen = directives.filter((directive) =>
    SENSITIVE_PERMISSION_FEATURES.has(directive.feature) && directive.allowlist.includes('*')
  );
  if (dangerouslyOpen.length) return policyResult('dangerously_open', {
    severity: 'Medium',
    reason: 'Sensitive browser capabilities are granted to every origin.',
    directives,
    dangerouslyOpen
  });

  return policyResult('configured', {
    severity: 'Info',
    reason: 'A syntactically valid Permissions-Policy is present without a wildcard grant for sensitive capabilities.',
    pass: true,
    directives
  });
}

export function parseReferrerPolicy(headers) {
  const values = headerValues(headers, 'referrer-policy');
  if (!values.length) return policyResult('missing', {
    severity: 'Low',
    reason: 'Referrer-Policy is missing.',
    policies: []
  });
  const tokens = values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const valid = tokens.filter((token) => VALID_REFERRER_POLICIES.has(token));
  const invalid = tokens.filter((token) => !VALID_REFERRER_POLICIES.has(token));
  if (!valid.length || invalid.length) return policyResult('invalid', {
    severity: 'Low',
    reason: 'Referrer-Policy contains no exclusively valid policy sequence.',
    policies: tokens,
    valid,
    invalid
  });
  const effective = valid.at(-1);
  if (UNSAFE_REFERRER_POLICIES.has(effective)) return policyResult('unsafe', {
    severity: 'Low',
    reason: `The effective Referrer-Policy ${effective} is below the audit standard.`,
    policies: tokens,
    effective,
    recommended: RECOMMENDED_REFERRER_POLICY
  });
  return policyResult('configured', {
    severity: 'Info',
    reason: effective === RECOMMENDED_REFERRER_POLICY
      ? 'The recommended Referrer-Policy is effective.'
      : 'A valid controlled Referrer-Policy is effective.',
    pass: true,
    policies: tokens,
    effective,
    qualityTier: effective === RECOMMENDED_REFERRER_POLICY ? 'recommended' : 'valid_alternative',
    recommended: RECOMMENDED_REFERRER_POLICY
  });
}

export function parseXContentTypeOptions(headers) {
  const values = headerValues(headers, 'x-content-type-options')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!values.length) return policyResult('missing', {
    severity: 'Low',
    reason: 'X-Content-Type-Options is missing.',
    values
  });
  if (values.some((value) => value !== 'nosniff')) return policyResult('invalid', {
    severity: 'Low',
    reason: 'X-Content-Type-Options must contain only nosniff.',
    values
  });
  return policyResult('protected', {
    severity: 'Info',
    reason: 'X-Content-Type-Options: nosniff is effective.',
    pass: true,
    values
  });
}

export function parseFrameProtection(headers) {
  const csp = parseContentSecurityPolicy(headers);
  const frameAncestors = csp.frameAncestors || [];
  const xfoValues = headerValues(headers, 'x-frame-options')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  const validXfo = xfoValues.length > 0
    && xfoValues.every((value) => value === 'DENY' || value === 'SAMEORIGIN')
    && new Set(xfoValues).size === 1;

  if (frameAncestors.length) {
    const permissive = frameAncestors.includes('*');
    if (permissive) return policyResult('unprotected', {
      severity: 'Low',
      reason: 'CSP frame-ancestors permits every origin.',
      csp,
      frameAncestors,
      xFrameOptions: xfoValues,
      conflict: validXfo
    });
    return policyResult('protected_by_csp', {
      severity: 'Info',
      reason: 'Enforced CSP frame-ancestors provides effective frame protection.',
      pass: true,
      csp,
      frameAncestors,
      xFrameOptions: xfoValues,
      xFrameOptionsIgnored: xfoValues.length > 0
    });
  }

  if (validXfo) return policyResult('protected_by_xfo', {
    severity: 'Info',
    reason: 'A valid X-Frame-Options policy provides frame protection.',
    pass: true,
    csp,
    xFrameOptions: xfoValues
  });
  return policyResult(xfoValues.length ? 'invalid' : 'missing', {
    severity: 'Low',
    reason: xfoValues.length
      ? 'X-Frame-Options is invalid or contradictory and no enforced frame-ancestors directive protects the response.'
      : 'Neither an enforced frame-ancestors directive nor X-Frame-Options protects the response.',
    csp,
    xFrameOptions: xfoValues
  });
}

export function parseHsts(headers, options = {}) {
  const responseUrl = String(options.url || '');
  if (responseUrl && !responseUrl.startsWith('https://')) return policyResult('not_applicable', {
    severity: 'Info',
    reason: 'HSTS is evaluated only on HTTPS responses.',
    pass: false
  });
  const values = headerValues(headers, 'strict-transport-security');
  if (!values.length) return policyResult('missing', {
    severity: 'Low',
    reason: 'Strict-Transport-Security is missing.',
    directives: {}
  });
  const directives = {};
  const errors = [];
  for (const raw of values.join(';').split(';').map((value) => value.trim()).filter(Boolean)) {
    const [rawName, ...rest] = raw.split('=');
    const name = rawName.toLowerCase();
    const value = rest.join('=').trim();
    if (Object.hasOwn(directives, name)) errors.push({ directive: name, reason: 'duplicate_directive' });
    directives[name] = value || true;
  }
  const maxAgeRaw = directives['max-age'];
  const maxAge = typeof maxAgeRaw === 'string' && /^\d+$/.test(maxAgeRaw) ? Number(maxAgeRaw) : null;
  if (errors.length || maxAge === null) return policyResult('invalid', {
    severity: 'Low',
    reason: 'Strict-Transport-Security is syntactically invalid or has no valid max-age.',
    directives,
    errors,
    maxAge
  });
  const minimum = Number(options.minimumMaxAgeSeconds ?? HSTS_MINIMUM_MAX_AGE_SECONDS);
  if (maxAge < minimum) return policyResult(maxAge === 0 ? 'disabled' : 'too_short', {
    severity: 'Low',
    reason: maxAge === 0
      ? 'Strict-Transport-Security is explicitly disabled.'
      : 'Strict-Transport-Security max-age is below the current versioned minimum.',
    directives,
    maxAge,
    minimumMaxAgeSeconds: minimum,
    includeSubDomains: Object.hasOwn(directives, 'includesubdomains'),
    preload: Object.hasOwn(directives, 'preload')
  });
  return policyResult('protected', {
    severity: 'Info',
    reason: 'Strict-Transport-Security meets the current versioned minimum max-age.',
    pass: true,
    directives,
    maxAge,
    minimumMaxAgeSeconds: minimum,
    includeSubDomains: Object.hasOwn(directives, 'includesubdomains'),
    preload: Object.hasOwn(directives, 'preload')
  });
}

export function parseCrossOriginPolicies(headers) {
  return {
    logicVersion: HEADER_POLICY_VERSION,
    coep: parseEnumeratedHeader(
      headers,
      'cross-origin-embedder-policy',
      ['require-corp', 'credentialless', 'unsafe-none'],
      ['require-corp', 'credentialless']
    ),
    coop: parseEnumeratedHeader(
      headers,
      'cross-origin-opener-policy',
      ['same-origin', 'same-origin-allow-popups', 'unsafe-none'],
      ['same-origin', 'same-origin-allow-popups']
    ),
    corp: parseEnumeratedHeader(
      headers,
      'cross-origin-resource-policy',
      ['same-origin', 'same-site', 'cross-origin'],
      ['same-origin', 'same-site']
    )
  };
}

export function parseCachePolicy(headers, options = {}) {
  const bag = normalizedHeaderBag(headers);
  const cacheControlValues = headerValues(bag, 'cache-control');
  const directives = {};
  const errors = [];
  for (const raw of cacheControlValues.flatMap((value) => value.split(','))) {
    const [rawName, ...rest] = raw.trim().split('=');
    if (!rawName) continue;
    const name = rawName.toLowerCase();
    const rawValue = rest.join('=').replace(/^"|"$/g, '').trim();
    if (Object.hasOwn(directives, name)) errors.push({ directive: name, reason: 'duplicate_directive' });
    directives[name] = rawValue || true;
  }
  const maxAge = numericDirective(directives['max-age']);
  const sharedMaxAge = numericDirective(directives['s-maxage']);
  const validators = {
    etag: Boolean(bag.etag),
    lastModified: Boolean(bag['last-modified'])
  };
  const expires = bag.expires || null;
  const resourceKind = options.resourceKind || 'html';
  const personalized = Boolean(options.personalized);
  const explicitlyUncacheable = Object.hasOwn(directives, 'no-store')
    || maxAge === 0
    || sharedMaxAge === 0;
  const revalidationOnly = Object.hasOwn(directives, 'no-cache');
  const effectiveTtlSeconds = sharedMaxAge ?? maxAge;

  if (personalized) return policyResult('not_applicable', {
    severity: 'Info',
    reason: 'The response is classified as personalized or authenticated.',
    directives,
    validators,
    expires
  });
  if (resourceKind === 'static' && (explicitlyUncacheable || revalidationOnly)) {
    return policyResult('static_uncacheable', {
      severity: 'Low',
      reason: 'A cacheable static resource is explicitly uncacheable or forced to revalidate.',
      directives,
      errors,
      validators,
      expires,
      effectiveTtlSeconds
    });
  }
  if (resourceKind === 'static' && !cacheControlValues.length && !expires && !validators.etag && !validators.lastModified) {
    return policyResult('static_policy_missing', {
      severity: 'Low',
      reason: 'A cacheable static resource has no cache policy or validator evidence.',
      directives,
      errors,
      validators,
      expires,
      effectiveTtlSeconds
    });
  }
  if (resourceKind === 'html' && Object.hasOwn(directives, 'no-store')) {
    return policyResult('html_no_store_observed', {
      severity: 'Info',
      reason: 'HTML explicitly disables storage; this observation is not an automatic cache failure without stronger page-dynamism evidence.',
      pass: true,
      directives,
      errors,
      validators,
      expires,
      effectiveTtlSeconds
    });
  }
  if (resourceKind === 'html' && revalidationOnly && (validators.etag || validators.lastModified)) {
    return policyResult('html_revalidation', {
      severity: 'Info',
      reason: 'HTML is explicitly revalidated with a stored validator.',
      pass: true,
      directives,
      errors,
      validators,
      expires,
      effectiveTtlSeconds
    });
  }
  if (resourceKind === 'html' && revalidationOnly && !validators.etag && !validators.lastModified) {
    return policyResult('html_revalidation_observed', {
      severity: 'Info',
      reason: 'HTML requires revalidation without a retained validator; HTML no-cache is not automatically a failure.',
      pass: true,
      directives,
      errors,
      validators,
      expires,
      effectiveTtlSeconds
    });
  }
  if (resourceKind === 'html' && !cacheControlValues.length && !expires && !validators.etag && !validators.lastModified) {
    return policyResult('html_policy_unspecified', {
      severity: 'Info',
      reason: 'No HTML cache policy was retained; static-resource policy remains the score-capable requirement.',
      pass: true,
      directives,
      errors,
      validators,
      expires,
      effectiveTtlSeconds
    });
  }
  if (errors.length) return policyResult('invalid', {
    severity: 'Low',
    reason: 'Cache-Control contains contradictory duplicate directives.',
    directives,
    errors,
    validators,
    expires,
    effectiveTtlSeconds
  });
  return policyResult('configured', {
    severity: 'Info',
    reason: 'The stored response contains usable cache-policy or validator evidence.',
    pass: true,
    directives,
    validators,
    expires,
    effectiveTtlSeconds
  });
}

export function evaluateCompression(headers, options = {}) {
  const contentType = String(options.contentType || normalizedHeaderBag(headers)['content-type'] || '').toLowerCase();
  const bodyBytes = Number(options.bodyBytes);
  const threshold = Number(options.minimumBodyBytes ?? COMPRESSION_MINIMUM_BODY_BYTES);
  const encoding = String(normalizedHeaderBag(headers)['content-encoding'] || '').toLowerCase();
  const compressible = /(?:^text\/|javascript|json|xml|svg)/i.test(contentType);
  if (!compressible) return policyResult('not_applicable', {
    severity: 'Info',
    reason: 'The response content type is not classified as text-compressible.',
    contentType,
    bodyBytes,
    minimumBodyBytes: threshold
  });
  if (!Number.isFinite(bodyBytes)) return policyResult('insufficient_evidence', {
    severity: 'Info',
    reason: 'Decoded response size is unavailable.',
    contentType,
    bodyBytes: null,
    minimumBodyBytes: threshold
  });
  if (bodyBytes < threshold) return policyResult('not_applicable', {
    severity: 'Info',
    reason: 'The response is below the current versioned compression minimum size.',
    contentType,
    bodyBytes,
    minimumBodyBytes: threshold
  });
  if (!/\b(?:gzip|br|zstd)\b/.test(encoding)) return policyResult('uncompressed', {
    severity: 'Low',
    reason: 'A sufficiently large text-compressible response has no supported Content-Encoding.',
    contentType,
    bodyBytes,
    minimumBodyBytes: threshold,
    contentEncoding: encoding || null
  });
  return policyResult('compressed', {
    severity: 'Info',
    reason: 'A supported transfer encoding is present for the compressible response.',
    pass: true,
    contentType,
    bodyBytes,
    minimumBodyBytes: threshold,
    contentEncoding: encoding
  });
}

function parseCspPolicy(value) {
  const directives = {};
  const errors = [];
  for (const rawDirective of String(value || '').split(';')) {
    const trimmed = rawDirective.trim();
    if (!trimmed) continue;
    const [rawName, ...tokens] = trimmed.split(/\s+/);
    const name = rawName.toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      errors.push({ directive: trimmed, reason: 'invalid_directive_name' });
      continue;
    }
    if (Object.hasOwn(directives, name)) {
      errors.push({ directive: name, reason: 'duplicate_directive' });
      continue;
    }
    directives[name] = tokens;
  }
  if (!Object.keys(directives).length) errors.push({ reason: 'empty_policy' });
  return { rawLength: String(value || '').length, directives, errors };
}

function cspSevereWeaknesses(policy) {
  const executable = policy.directives['script-src'] || policy.directives['default-src'] || [];
  const hasBroadSource = executable.includes('*') || executable.includes('http:') || executable.includes('https:');
  const hasUnsafeEval = executable.includes("'unsafe-eval'");
  const hasUnsafeInline = executable.includes("'unsafe-inline'");
  const hasNonceOrHash = executable.some((token) => /^'(?:nonce-|sha256-|sha384-|sha512-)/.test(token));
  const weaknesses = [];
  if (hasUnsafeEval) weaknesses.push('unsafe_eval_execution');
  if (hasUnsafeInline && !hasNonceOrHash) {
    weaknesses.push(hasBroadSource
      ? 'broad_script_source_with_unsafe_execution'
      : 'unsafe_inline_execution_without_nonce_or_hash');
  }
  if (executable.includes('*')) weaknesses.push('unrestricted_script_sources');
  if ((policy.directives['object-src'] || []).includes('*')) weaknesses.push('unrestricted_object_sources');
  return [...new Set(weaknesses)];
}

function cspQualitySignals(policy) {
  const signals = [];
  const executable = policy.directives['script-src'] || policy.directives['default-src'] || [];
  if (executable.includes("'unsafe-inline'")) signals.push('unsafe_inline_present');
  if (executable.includes("'unsafe-eval'")) signals.push('unsafe_eval_present');
  if (!policy.directives['default-src']) signals.push('default_src_missing');
  return signals;
}

function parseEnumeratedHeader(headers, name, allowed, protectiveValues = []) {
  const values = headerValues(headers, name)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!values.length) return {
    state: 'not_configured',
    present: false,
    values: [],
    effective: null,
    syntacticallyValid: false,
    protective: false
  };
  const invalid = values.filter((value) => !allowed.includes(value));
  if (invalid.length || new Set(values).size > 1) {
    return {
      state: 'invalid_or_conflicting',
      present: true,
      values,
      invalid,
      effective: null,
      syntacticallyValid: false,
      protective: false
    };
  }
  const effective = values[0];
  const protective = protectiveValues.includes(effective);
  return {
    state: protective ? 'protective' : 'permissive',
    present: true,
    values,
    invalid: [],
    effective,
    syntacticallyValid: true,
    protective
  };
}

function tokenizeAllowlist(value) {
  const tokens = String(value || '').match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
  for (const token of tokens) {
    if (token === '*' || token === 'self' || token === "'self'") continue;
    const unquoted = token.replace(/^"|"$/g, '');
    if (/^https?:\/\/[^\s/]+(?::\d+)?$/i.test(unquoted)) continue;
    return { valid: false, reason: 'invalid_allowlist_token', tokens };
  }
  return { valid: true, tokens };
}

function splitOutsideParentheses(value, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const char of String(value || '')) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function splitCombinedCsp(value) {
  return splitOutsideParentheses(value, ',').map((entry) => entry.trim()).filter(Boolean);
}

function numericDirective(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  return Number(value);
}

function policyResult(state, details) {
  return {
    logicVersion: HEADER_POLICY_VERSION,
    state,
    pass: false,
    ...details
  };
}
