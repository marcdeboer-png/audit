import {
  HTML_WHERE,
  all,
  availabilityResult,
  count,
  dedupeLinkSamples,
  htmlPageCount,
  makeResult,
  safeJson,
  sampleUrls
} from '../helpers.js';
import {
  AI_ROBOTS_POLICY_VERSION,
  parseRobotsPolicy,
  summarizeAiBotRules,
  SUPPORTED_AI_BOTS
} from '../../utils/robots.js';
import {
  analyzeLlmsTxtAsset,
  classifyLlmsAvailability,
  LLMS_TXT_VALIDATION_VERSION
} from '../../utils/llmsTxt.js';
import { hasVisibleTextProvenance, VISIBLE_TEXT_NORMALIZATION_VERSION } from '../../extractors/visibleText.js';
import { analyzeRobotsAsset } from '../../utils/discoverySemantics.js';
import { evaluatePageTypeSchemaCoverage, STRUCTURED_DATA_COVERAGE_LOGIC_VERSION } from '../structuredDataCoverage.js';
import { SCHEMA_TYPE_HIERARCHY_VERSION } from '../../extractors/structuredData.js';
import { activeStandardChecks } from '../standardMetadata.js';

const geo = (id, category, name, run, options = {}) => ({
  id: `geo.${id}`,
  category,
  name,
  auditType: 'geo',
  priority: options.priority || 'Medium',
  effort: options.effort || 'M',
  recommendation: options.recommendation || '',
  findingType: options.findingType,
  evidenceClass: options.evidenceClass,
  coverageUnitKey: options.coverageUnitKey,
  scoreDeduplicationKey: options.scoreDeduplicationKey,
  rootCauseFamily: options.rootCauseFamily,
  scopeType: options.scopeType,
  relatedCheckIds: options.relatedCheckIds,
  checkVersion: options.checkVersion,
  run
});

const trust = (id, category, name, run, options = {}) => ({
  id: `trust.${id}`,
  category,
  name,
  auditType: 'geo',
  priority: options.priority || 'Medium',
  effort: options.effort || 'M',
  recommendation: options.recommendation || '',
  run
});

const AI_BOTS = SUPPORTED_AI_BOTS;
const AI_POLICY_ROOT_CAUSE = 'ai_crawler_policy.robots_configuration';
const LLMS_TXT_ROOT_CAUSE = 'ai_files.llms_txt';
const AI_POLICY_CHECK_VERSION = 'ai-bot-policy-check-v2';
const LLMS_TXT_CHECK_VERSION = 'llms-txt-check-v2';
const VISIBLE_TEXT_FACTS_WHERE = `COALESCE(textFactsJson, '') LIKE '%"normalization_version":"${VISIBLE_TEXT_NORMALIZATION_VERSION}"%'`;
const ABOUT_TARGET_PATTERNS = [
  { needle: '/about', pattern: /(^|\/)about(\/|$)/i },
  { needle: '/about-us', pattern: /(^|\/)about-us(\/|$)/i },
  { needle: '/ueber', pattern: /(^|\/)ueber(\/|$)/i },
  { needle: '/ueber-uns', pattern: /(^|\/)ueber-uns(\/|$)/i },
  { needle: '/über-uns', pattern: /(^|\/)über-uns(\/|$)/i },
  { needle: '/ueber-mich', pattern: /(^|\/)ueber-mich(\/|$)/i },
  { needle: '/über-mich', pattern: /(^|\/)über-mich(\/|$)/i },
  { needle: '/unternehmen', pattern: /(^|\/)unternehmen(\/|$)/i },
  { needle: '/company', pattern: /(^|\/)company(\/|$)/i },
  { needle: '/team', pattern: /(^|\/)team(\/|$)/i }
];
const ABOUT_ANCHOR_LABELS = [
  'about',
  'about us',
  'ueber',
  'ueber uns',
  'über uns',
  'ueber mich',
  'über mich',
  'unternehmen',
  'company',
  'team',
  'das team'
];

export function geoChecks() {
  return activeStandardChecks([
    llmsTxtPresent(),
    llmsTxtStatus(),
    llmsFullTxtPresent(),
    robotsBlocksTxt(),
    ...AI_BOTS.map((bot) => robotsMentionsBot(bot)),
    aiBotsPolicySummary(),
    markdownTwinCheck(),
    faqHtmlMissingSchema(),
    tablesCoverage(),
    signalCoverage('bulletpoints_lists_present', 'Content Structure Signals', 'Bulletpoints/lists present', 'hasLists', 'lists'),
    sourceLinksPresent(),
    articleSignalCoverage('visible_dates_present', 'Entity & Freshness Signals', 'Visible date signals present', 'hasVisibleDate', 'dates'),
    articleSignalCoverage('author_hints_present', 'Entity & Freshness Signals', 'Author hints heuristically present', 'hasAuthorPattern', 'author hints'),
    internalNavLink('impressum_linked', 'Trust & Contact Signals', 'Impressum internally linked', ['impressum', 'legal notice']),
    internalNavLink('datenschutz_linked', 'Trust & Contact Signals', 'Datenschutz internally linked', ['datenschutz', 'privacy']),
    internalNavLink('about_linked', 'Trust & Contact Signals', 'About/Über-uns page internally linked', ['about', 'ueber-uns', 'über-uns', 'company', 'unternehmen']),
    internalNavLink('contact_linked', 'Trust & Contact Signals', 'Contact page internally linked', ['contact', 'kontakt']),
    eeatSignalSummary(),
    ymylReviewSignal(),
    organizationSameAs(),
    breadcrumbPresence(),
    schemaPresence('speakable_present', 'GEO Opportunities', 'Speakable Schema vorhanden', 'SpeakableSpecification', 'Low'),
    articleBlogWithArticleSchema(),
    lowStructuredSections()
  ]);
}

function getAsset(ctx, type) {
  return ctx.db.prepare(`
    SELECT *
    FROM domain_assets
    WHERE runId = ? AND type = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(ctx.run.id, type);
}

function assetHttpResponseGate(check, asset, factName) {
  if (!asset) {
    return availabilityResult(check, 'not_executed', {
      finding: `${check.name}: no HTTP asset observation was collected.`,
      details: 'The absence of a domain-asset row is not treated as an HTTP failure.',
      recommendation: 'Repeat only the targeted domain-asset request if this signal is needed.',
      facts: { assetObserved: false },
      evidence: { factName, source: 'domain_assets' },
      requirements: { requiredFacts: [factName], missingFacts: [factName], canCollectWithTargetedRun: true }
    });
  }
  if (asset.statusCode === null || asset.statusCode === undefined) {
    return availabilityResult(check, 'technical_error', {
      finding: `${check.name}: no stable HTTP response was available.`,
      details: 'A network or request failure is not scored as a website defect.',
      recommendation: 'Repeat the small targeted HTTP request after resolving the technical collection error.',
      facts: { assetObserved: true, statusCode: null },
      evidence: { factName, url: asset.url, source: 'domain_assets' },
      requirements: { requiredFacts: [factName], missingFacts: [factName], canCollectWithTargetedRun: true }
    });
  }
  return null;
}

function assetContentGate(check, asset, factName) {
  const responseGate = assetHttpResponseGate(check, asset, `${factName}HttpResponse`);
  if (responseGate) return responseGate;
  if (asset.content === null || asset.content === undefined) {
    return availabilityResult(check, 'insufficient_evidence', {
      finding: `${check.name}: the HTTP response was observed, but retained content is unavailable.`,
      details: 'Missing retained content is not equivalent to an empty response body.',
      recommendation: 'Repeat the targeted request with domain-asset content retention if policy parsing is required.',
      facts: { assetObserved: true, statusCode: asset.statusCode, contentObserved: false },
      evidence: { factName, url: asset.url, source: 'domain_assets' },
      requirements: { requiredFacts: [factName], missingFacts: [factName], canCollectWithTargetedRun: true }
    });
  }
  return null;
}

function robotsPolicyGate(check, asset) {
  const responseGate = assetHttpResponseGate(check, asset, 'robotsTxtHttpResponse');
  if (responseGate) return responseGate;
  const analysis = analyzeRobotsAsset(asset);
  if (!analysis.provenanceComplete) return availabilityResult(check, 'insufficient_evidence', {
    finding: `${check.name}: robots.txt exists, but complete initial/final host and redirect provenance is unavailable.`,
    facts: { robotsState: analysis.state, provenanceComplete: false },
    evidence: { ...analysis, policyVersion: AI_ROBOTS_POLICY_VERSION },
    requirements: { requiredFacts: ['completeRobotsHostRedirectProvenance'], missingFacts: ['completeRobotsHostRedirectProvenance'], canCollectWithTargetedRun: true }
  });
  if (analysis.state === 'absent') return null;
  if (!['valid', 'valid_empty'].includes(analysis.state)) return availabilityResult(check, analysis.state === 'technical_error' ? 'technical_error' : 'insufficient_evidence', {
    finding: `${check.name}: robots.txt policy is unavailable or invalid (${analysis.state}).`,
    facts: { robotsState: analysis.state },
    evidence: { ...analysis, policyVersion: AI_ROBOTS_POLICY_VERSION },
    requirements: { requiredFacts: ['stableRobotsTxtGet', 'usableRobotsTxtPolicy'], missingFacts: ['usableRobotsTxtPolicy'], canCollectWithTargetedRun: true }
  });
  if (asset.content === null || asset.content === undefined) return availabilityResult(check, 'insufficient_evidence', {
    finding: `${check.name}: robots.txt content was not retained for policy evaluation.`,
    facts: { robotsState: analysis.state, contentObserved: false },
    evidence: { ...analysis, policyVersion: AI_ROBOTS_POLICY_VERSION },
    requirements: { requiredFacts: ['robotsTxtContent'], missingFacts: ['robotsTxtContent'], canCollectWithTargetedRun: true }
  });
  const parsed = parseRobotsPolicy(asset.content);
  if (!parsed.valid) return availabilityResult(check, 'insufficient_evidence', {
    finding: `${check.name}: robots.txt could not be parsed into a reliable policy.`,
    facts: { robotsState: analysis.state, parserValid: false },
    evidence: {
      ...analysis,
      policyVersion: AI_ROBOTS_POLICY_VERSION,
      parserErrors: parsed.errors,
      unknownDirectives: parsed.unknownDirectives
    },
    requirements: { requiredFacts: ['reliablyParsedRobotsPolicy'], missingFacts: ['reliablyParsedRobotsPolicy'], canCollectWithTargetedRun: true }
  });
  return null;
}

function contentTypeForAsset(_ctx, assetOrUrl) {
  const row = typeof assetOrUrl === 'object' && assetOrUrl
    ? assetOrUrl
    : null;
  const headers = safeJson(row?.responseHeadersJson, {});
  return String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
}

function isMarkdownLikeAsset(row, contentType = '') {
  const url = String(row?.url || '').toLowerCase();
  const sample = String(row?.contentSample || '').trim();
  if (/text\/markdown|text\/plain|application\/markdown/.test(contentType)) return true;
  if (/text\/html/.test(contentType)) return false;
  if (/\.(md|markdown|txt)(?:[?#]|$)/.test(url)) {
    return /^#\s|\n#\s|^- |\n- |\[[^\]]+\]\([^)]+\)/m.test(sample) || !/<html[\s>]/i.test(sample);
  }
  return false;
}

function llmsTxtPresent() {
  return geo('llms_txt_present', 'GEO Opportunities', 'llms.txt vorhanden', function run(ctx) {
    const asset = getAsset(ctx, 'llms');
    const evaluated = evaluateLlmsTxtAsset(this, asset);
    if (evaluated.gate) return evaluated.gate;
    const analysis = evaluated.analysis;
    return makeResult(this, analysis.pass ? 'OK' : 'Warning', {
      affectedCount: analysis.pass ? 0 : 1,
      finding: analysis.pass
        ? `llms.txt is a direct, stable HTTP 200 UTF-8 text resource for ${analysis.content.siteDesignation}.`
        : `llms.txt does not meet the minimum usable-resource standard: ${analysis.failureReasons.join(', ')}.`,
      recommendation: 'Publish a direct HTTP 200 UTF-8 text/Markdown llms.txt with a clear site identity and at least one usable section or canonical internal target.',
      facts: {
        llmsTxtPresent: analysis.pass,
        siteDesignation: analysis.content.siteDesignation,
        usableSectionCount: analysis.content.usableSectionCount,
        internalUrlCount: analysis.content.internalUrlCount
      },
      evidence: compactLlmsEvidence(analysis),
      requirements: {
        requiredFacts: ['stableDirectLlmsTxtHttp200', 'validTextRepresentation', 'utf8Content', 'siteDesignation', 'usableSectionOrInternalTarget'],
        optionalFacts: [],
        missingFacts: [],
        minimumCoverage: 1,
        canCollectWithTargetedRun: true
      },
      relatedCheckIds: ['geo.llms_txt_http_status'],
      deduplicationReason: 'Presence and HTTP/resource validity describe the same llms.txt root cause.',
      reportGroupingKey: LLMS_TXT_ROOT_CAUSE
    });
  }, {
    priority: 'Low',
    effort: 'S',
    findingType: 'core_issue',
    evidenceClass: 'primary_required',
    coverageUnitKey: 'site:ai_files:llms_txt',
    scoreDeduplicationKey: LLMS_TXT_ROOT_CAUSE,
    rootCauseFamily: LLMS_TXT_ROOT_CAUSE,
    scopeType: 'site',
    relatedCheckIds: ['geo.llms_txt_http_status'],
    checkVersion: LLMS_TXT_CHECK_VERSION
  });
}

function llmsTxtStatus() {
  return geo('llms_txt_http_status', 'GEO Opportunities', 'llms.txt HTTP status', function run(ctx) {
    const asset = getAsset(ctx, 'llms');
    const evaluated = evaluateLlmsTxtAsset(this, asset);
    if (evaluated.gate) return evaluated.gate;
    const analysis = evaluated.analysis;
    return makeResult(this, analysis.pass ? 'OK' : 'Warning', {
      affectedCount: analysis.pass ? 0 : 1,
      finding: analysis.pass
        ? 'llms.txt returned a stable direct HTTP 200 text response without redirects.'
        : `llms.txt HTTP/resource validation failed: ${analysis.failureReasons.join(', ')}.`,
      recommendation: 'Serve the canonical /llms.txt directly as a stable HTTP 200 UTF-8 text/Markdown response without redirects or soft-error content.',
      facts: {
        initialStatusCode: analysis.initialStatusCode,
        finalStatusCode: analysis.finalStatusCode,
        direct200: analysis.direct200,
        measurementState: analysis.measurementState
      },
      evidence: compactLlmsEvidence(analysis),
      requirements: {
        requiredFacts: ['directInitialAndFinalHttp200', 'completeRedirectProvenance', 'stableMeasurement', 'usableTextRepresentation'],
        optionalFacts: [],
        missingFacts: [],
        minimumCoverage: 1,
        canCollectWithTargetedRun: true
      },
      relatedCheckIds: ['geo.llms_txt_present'],
      deduplicationReason: 'HTTP/resource validity and llms.txt presence describe one canonical resource root cause.',
      reportGroupingKey: LLMS_TXT_ROOT_CAUSE
    });
  }, {
    priority: 'Low',
    effort: 'S',
    findingType: 'core_issue',
    evidenceClass: 'primary_required',
    coverageUnitKey: 'site:ai_files:llms_txt',
    scoreDeduplicationKey: LLMS_TXT_ROOT_CAUSE,
    rootCauseFamily: LLMS_TXT_ROOT_CAUSE,
    scopeType: 'site',
    relatedCheckIds: ['geo.llms_txt_present'],
    checkVersion: LLMS_TXT_CHECK_VERSION
  });
}

function evaluateLlmsTxtAsset(check, asset) {
  const responseGate = assetHttpResponseGate(check, asset, 'llmsTxtHttpResponse');
  if (responseGate) return { gate: responseGate, analysis: null };
  const analysis = analyzeLlmsTxtAsset(asset);
  const availability = classifyLlmsAvailability(analysis);
  if (!availability) return { gate: null, analysis };
  return {
    gate: availabilityResult(check, availability, {
      finding: `${check.name}: llms.txt could not be conclusively evaluated (${analysis.failureReasons.join(', ')}).`,
      details: 'Incomplete, truncated, unstable, rate-limited or historical HTTP provenance is not treated as a pass or a website failure.',
      recommendation: 'Repeat the bounded direct GET measurement and retain compact initial/final status, content and stability evidence.',
      facts: {
        measurementState: analysis.measurementState,
        provenanceComplete: analysis.provenanceComplete,
        truncated: analysis.truncated
      },
      evidence: compactLlmsEvidence(analysis),
      requirements: {
        requiredFacts: ['completeStableLlmsTxtMeasurement'],
        missingFacts: analysis.failureReasons,
        minimumCoverage: 1,
        canCollectWithTargetedRun: true
      },
      scoreDeduplicationKey: LLMS_TXT_ROOT_CAUSE
    }),
    analysis
  };
}

function compactLlmsEvidence(analysis) {
  return {
    validationVersion: analysis.version,
    url: analysis.url,
    initialStatusCode: analysis.initialStatusCode,
    redirectChain: analysis.redirectChain,
    finalStatusCode: analysis.finalStatusCode,
    finalUrl: analysis.finalUrl,
    contentType: analysis.contentType,
    measurementState: analysis.measurementState,
    measurementAttempts: analysis.attempts,
    provenanceComplete: analysis.provenanceComplete,
    truncated: analysis.truncated,
    bodyBytes: analysis.content.bodyBytes,
    charset: analysis.content.charset,
    utf8Valid: analysis.content.utf8Valid,
    looksHtml: analysis.content.looksHtml,
    contentHash: analysis.content.contentHash,
    headings: analysis.content.headings,
    siteDesignation: analysis.content.siteDesignation,
    usableSections: analysis.content.usableSections,
    internalUrls: analysis.content.internalUrls,
    validationReasons: analysis.failureReasons
  };
}

function llmsFullTxtPresent() {
  return geo('llms_full_txt_present', 'GEO Opportunities', 'llms-full.txt vorhanden', function run(ctx) {
    const asset = getAsset(ctx, 'llms_full');
    const gate = assetHttpResponseGate(this, asset, 'llmsFullHttpResponse');
    if (gate) return gate;
    const ok = asset && asset.statusCode >= 200 && asset.statusCode < 300;
    const references = llmsFullReferences(ctx, asset?.url);
    if (!ok && !references.length) {
      return availabilityResult(this, 'not_applicable', {
        finding: `llms-full.txt returned ${asset?.statusCode ?? 'no stable response'} and is not referenced; the optional file was not scored as a defect.`,
        details: 'A missing optional full-corpus file is different from a broken referenced resource or a server error.',
        recommendation: 'Publish /llms-full.txt only if the site intentionally maintains a full AI-readable corpus.',
        facts: { statusCode: asset?.statusCode ?? null, referenceCount: 0 },
        evidence: { url: asset?.url, statusCode: asset?.statusCode ?? null, references: [] },
        requirements: { requiredFacts: ['llmsFullIntentOrReference'], missingFacts: [], canCollectWithTargetedRun: false, reason: 'No site intent or reference makes this optional file applicable.' },
        scoreDeduplicationKey: 'ai_files.llms_full'
      });
    }
    const status = ok ? 'OK' : 'Warning';
    return makeResult(this, status, {
      affectedCount: status === 'Warning' ? 1 : 0,
      finding: ok
        ? 'llms-full.txt returned a 2xx status.'
        : references.length
          ? `llms-full.txt is referenced but returned ${asset?.statusCode ?? 'fetch failed'} instead of a usable 2xx status.`
          : `llms-full.txt returned ${asset?.statusCode ?? 'fetch failed'} instead of 2xx and is not referenced by stored assets; treat as optional unless a full AI-readable corpus is intended.`,
      recommendation: 'Publish /llms-full.txt only if the site maintains a full Markdown/AI-readable corpus.',
      evidence: { url: asset?.url, statusCode: asset?.statusCode ?? null, bytes: asset?.content?.length || 0, references },
      requirements: { requiredFacts: ['llmsFullHttpResponse', 'llmsFullReference'], optionalFacts: [], missingFacts: [], minimumCoverage: 1, canCollectWithTargetedRun: true },
      findingType: ok ? 'info' : 'opportunity',
      confidence: references.length ? 'high' : 'medium',
      reviewRecommended: references.length > 0,
      scoreDeduplicationKey: 'ai_files.llms_full'
    });
  }, { priority: 'Low' });
}

function llmsFullReferences(ctx, candidateUrl) {
  const references = [];
  const candidate = comparableUrl(candidateUrl);
  const assets = all(ctx.db, `
    SELECT type, url, content
    FROM domain_assets
    WHERE runId = ?
  `, [ctx.run.id]);
  for (const asset of assets) {
    if (/llms-full\.txt/i.test(asset.content || '') && comparableUrl(asset.url) !== candidate) {
      references.push({ sourceType: asset.type, sourceUrl: asset.url, targetUrl: candidateUrl || null });
    }
  }
  const linkRows = all(ctx.db, `
    SELECT sourceUrl, targetUrl
    FROM page_links
    WHERE runId = ? AND LOWER(targetUrl) LIKE '%llms-full.txt%'
    LIMIT 10
  `, [ctx.run.id]);
  for (const row of linkRows) {
    if (comparableUrl(row.sourceUrl) === comparableUrl(row.targetUrl)) continue;
    references.push({ sourceType: 'html_link', sourceUrl: row.sourceUrl, targetUrl: row.targetUrl });
  }
  const resourceRows = all(ctx.db, `
    SELECT pageUrl, resourceUrl
    FROM resources
    WHERE runId = ? AND LOWER(resourceUrl) LIKE '%llms-full.txt%'
    LIMIT 10
  `, [ctx.run.id]);
  for (const row of resourceRows) {
    if (comparableUrl(row.pageUrl) === comparableUrl(row.resourceUrl)) continue;
    references.push({ sourceType: 'resource', sourceUrl: row.pageUrl, targetUrl: row.resourceUrl });
  }
  return references.slice(0, 20);
}

function comparableUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return String(value || '').trim().replace(/\/$/, '').toLowerCase();
  }
}

function robotsBlocksTxt() {
  return geo('robots_blocks_txt_files', 'AI File Access', 'robots.txt blockiert llms.txt', function run(ctx) {
    const robots = getAsset(ctx, 'robots');
    const gate = robotsPolicyGate(this, robots);
    if (gate) return gate;
    const robotsAnalysis = analyzeRobotsAsset(robots);
    const policyContent = robotsAnalysis.state === 'absent' ? '' : robots.content;
    const testedPaths = [{ path: '/llms.txt', role: 'llms_txt' }];
    const policies = summarizeAiBotRules(robots.url, policyContent, { testedPaths });
    const blocked = policies.filter((policy) => policy.status === 'blocked');
    return makeResult(this, blocked.length ? 'Warning' : 'OK', {
      priority: 'Medium',
      affectedCount: blocked.length,
      finding: blocked.length
        ? `${blocked.length} supported AI bot policy/policies block /llms.txt.`
        : '/llms.txt is crawlable for all supported AI bots under the published robots policy.',
      recommendation: 'Allow /llms.txt for every supported AI bot in the effective robots policy.',
      facts: {
        llmsTxtPath: '/llms.txt',
        supportedBotCount: AI_BOTS.length,
        blockedBotCount: blocked.length
      },
      evidence: {
        policyVersion: AI_ROBOTS_POLICY_VERSION,
        robots: compactRobotsAnalysis(robotsAnalysis),
        testedPaths,
        policies
      },
      requirements: {
        requiredFacts: ['stableRobotsTxtGet', 'reliablyParsedRobotsPolicy', 'effectiveLlmsTxtPolicyForEverySupportedBot'],
        optionalFacts: [],
        missingFacts: [],
        minimumCoverage: 1,
        canCollectWithTargetedRun: true
      },
      relatedCheckIds: [
        ...AI_BOTS.map(aiBotCheckId),
        'geo.llms_txt_present',
        'geo.llms_txt_http_status'
      ],
      deduplicationReason: 'The llms.txt access finding is a perspective on the same published AI crawler policy used by the individual bot checks.',
      reportGroupingKey: 'ai_crawler_policy.llms_txt_access'
    });
  }, {
    priority: 'Medium',
    effort: 'S',
    findingType: 'core_issue',
    evidenceClass: 'primary_required',
    coverageUnitKey: 'site:ai_policy:llms_txt_access',
    scoreDeduplicationKey: AI_POLICY_ROOT_CAUSE,
    rootCauseFamily: 'ai_crawler_policy',
    scopeType: 'site',
    relatedCheckIds: AI_BOTS.map(aiBotCheckId),
    checkVersion: AI_POLICY_CHECK_VERSION
  });
}

function robotsMentionsBot(botName) {
  const id = aiBotCheckId(botName).replace(/^geo\./, '');
  return geo(id, 'AI Crawler Policy', `robots.txt mentions ${botName}`, function run(ctx) {
    const robots = getAsset(ctx, 'robots');
    const gate = robotsPolicyGate(this, robots);
    if (gate) return gate;
    const robotsAnalysis = analyzeRobotsAsset(robots);
    const policyContent = robotsAnalysis.state === 'absent' ? '' : robots.content;
    const testedPaths = representativeAiPolicyPaths(ctx, robotsAnalysis.finalUrl || robots.url);
    const policy = summarizeAiBotRules(robots.url, policyContent, { testedPaths }).find((item) => item.bot === botName);
    const blocked = policy.status === 'blocked';
    const explicitPass = policy.status === 'explicitly_allowed';
    const status = explicitPass ? 'OK' : 'Warning';
    const priority = blocked ? 'Medium' : 'Low';
    return makeResult(this, status, {
      priority,
      affectedCount: status === 'Warning' ? Math.max(1, policy.blockedPathCount) : 0,
      finding: explicitPass
        ? `${botName} has an explicit group that allows every tested public path.`
        : blocked
          ? `${botName} is effectively blocked on ${policy.blockedPathCount}/${policy.testedPathCount} tested public path(s).`
          : `${botName} lacks a complete explicit allow policy and is only implicitly/default allowed.`,
      recommendation: `Publish an explicit ${botName} user-agent group whose effective rules allow the relevant public website scope.`,
      facts: {
        botName,
        explicitGroupPresent: policy.mentioned,
        policyStatus: policy.policyStatus,
        testedPathCount: policy.testedPathCount,
        blockedPathCount: policy.blockedPathCount
      },
      evidence: {
        policyVersion: AI_ROBOTS_POLICY_VERSION,
        botName,
        robots: compactRobotsAnalysis(robotsAnalysis),
        policy
      },
      requirements: {
        requiredFacts: ['stableRobotsTxtGet', 'reliablyParsedRobotsPolicy', 'explicitBotGroup', 'effectivePolicyForRepresentativePublicPaths'],
        optionalFacts: [],
        missingFacts: [],
        minimumCoverage: 1,
        canCollectWithTargetedRun: true
      },
      relatedCheckIds: [
        'geo.ai_bots_policy_summary',
        'geo.robots_blocks_txt_files',
        ...AI_BOTS.filter((bot) => bot !== botName).map(aiBotCheckId)
      ],
      deduplicationReason: 'All individual AI bot checks are perspectives on one published robots.txt configuration.',
      confidence: 'high',
      reportGroupingKey: `ai_crawler_policy.${botName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
    });
  }, {
    priority: 'Low',
    effort: 'S',
    findingType: 'core_issue',
    evidenceClass: 'primary_required',
    coverageUnitKey: `site:ai_policy:${botName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    scoreDeduplicationKey: AI_POLICY_ROOT_CAUSE,
    rootCauseFamily: 'ai_crawler_policy',
    scopeType: 'site',
    relatedCheckIds: ['geo.ai_bots_policy_summary', 'geo.robots_blocks_txt_files'],
    checkVersion: AI_POLICY_CHECK_VERSION
  });
}

function aiBotsPolicySummary() {
  return geo('ai_bots_policy_summary', 'AI Crawler Policy', 'AI bots allowed/blocked/unclear from robots.txt', function run(ctx) {
    const robots = getAsset(ctx, 'robots');
    const gate = robotsPolicyGate(this, robots);
    if (gate) return gate;
    const robotsAnalysis = analyzeRobotsAsset(robots);
    const policyContent = robotsAnalysis.state === 'absent' ? '' : robots.content;
    const testedPaths = representativeAiPolicyPaths(ctx, robotsAnalysis.finalUrl || robots.url);
    const summary = summarizeAiBotRules(robots.url, policyContent, { testedPaths });
    const counts = aiPolicyStatusCounts(summary);
    return makeResult(this, 'OK', {
      priority: 'Info',
      affectedCount: 0,
      finding: `AI bot policy inventory: ${counts.explicitlyAllowed} explicitly allowed, ${counts.implicitlyAllowed} implicitly allowed, ${counts.blocked} blocked, ${counts.unclear} unclear, ${counts.technicallyUnavailable} technically unavailable.`,
      recommendation: 'Use the individual bot checks for actionable findings; this summary adds no separate root cause or score deduction.',
      facts: counts,
      evidence: {
        policyVersion: AI_ROBOTS_POLICY_VERSION,
        robots: compactRobotsAnalysis(robotsAnalysis),
        testedPaths,
        summary
      },
      findingType: 'info',
      confidence: 'high',
      reportGroupingKey: 'ai_crawler_policy.summary',
      dataBasis: 'versioned robots.txt user-agent policy and representative public paths',
      evidenceLevel: 'fact',
      automationCoverage: 'full',
      interpretation: 'Diagnostic aggregation of the ten individual AI bot checks.',
      limitations: 'The summary does not create a pass/fail statement about site quality and never hides individual bot evidence.',
      scoreEligible: false,
      scoreExclusionReason: 'diagnostic_only_summary',
      reviewRecommended: false,
      requirements: {
        requiredFacts: ['stableRobotsTxtGet', 'reliablyParsedRobotsPolicy', 'individualBotPolicyResults'],
        optionalFacts: [],
        missingFacts: [],
        minimumCoverage: 1,
        canCollectWithTargetedRun: true
      },
      relatedCheckIds: AI_BOTS.map(aiBotCheckId)
    });
  }, {
    priority: 'Info',
    effort: 'S',
    findingType: 'info',
    evidenceClass: 'inventory',
    coverageUnitKey: 'site:ai_policy:summary',
    rootCauseFamily: 'ai_crawler_policy',
    scopeType: 'site',
    relatedCheckIds: AI_BOTS.map(aiBotCheckId),
    checkVersion: AI_POLICY_CHECK_VERSION
  });
}

function representativeAiPolicyPaths(ctx, robotsUrl) {
  const output = [
    { path: '/', role: 'homepage', pageType: 'homepage', sourceUrl: null },
    { path: '/llms.txt', role: 'llms_txt', pageType: null, sourceUrl: null }
  ];
  let primaryHost = null;
  try {
    primaryHost = new URL(robotsUrl).hostname.toLowerCase();
  } catch {
    return output;
  }
  const rows = all(ctx.db, `
    SELECT p.url, p.finalUrl, p.pageType
    FROM pages p
    LEFT JOIN crawl_queue q
      ON q.runId = p.runId
     AND q.normalizedUrl = p.normalizedUrl
    WHERE p.runId = ?
      AND p.statusCode >= 200
      AND p.statusCode < 300
      AND p.indexable = 1
      AND (p.contentType LIKE '%text/html%' OR p.contentType LIKE '%application/xhtml%')
      AND COALESCE(q.sourceType, '') NOT LIKE 'synthetic%'
    ORDER BY COALESCE(p.pageType, 'other') ASC, COALESCE(p.finalUrl, p.url) ASC
  `, [ctx.run.id]);
  const seenTypes = new Set(['homepage']);
  const seenPaths = new Set(output.map((item) => item.path));
  for (const row of rows) {
    const pageType = row.pageType || 'other';
    if (
      seenTypes.has(pageType) ||
      ['legal', 'search', 'search_results', 'internal_search', 'filter', 'utility', 'login', 'account', 'checkout'].includes(pageType)
    ) continue;
    let parsed;
    try {
      parsed = new URL(row.finalUrl || row.url);
    } catch {
      continue;
    }
    if (parsed.hostname.toLowerCase() !== primaryHost || isPrivateAiPolicyPath(parsed)) continue;
    const path = `${parsed.pathname || '/'}${parsed.search || ''}`;
    if (seenPaths.has(path)) continue;
    seenTypes.add(pageType);
    seenPaths.add(path);
    output.push({
      path,
      role: 'representative_public_page_type',
      pageType,
      sourceUrl: row.finalUrl || row.url
    });
  }
  return output;
}

function isPrivateAiPolicyPath(url) {
  return /(?:^|\/)(?:login|sign-?in|account|konto|admin|checkout|cart|warenkorb|api)(?:\/|$)/i.test(url.pathname) ||
    /[?&](?:token|session|auth|preview)=/i.test(url.search);
}

function compactRobotsAnalysis(analysis) {
  return {
    logicVersion: analysis.logicVersion,
    policyVersion: AI_ROBOTS_POLICY_VERSION,
    url: analysis.url,
    initialStatusCode: analysis.initialStatusCode,
    finalStatusCode: analysis.finalStatusCode,
    finalUrl: analysis.finalUrl,
    redirectChain: analysis.redirectChain,
    state: analysis.state,
    measurementState: analysis.measurementState,
    measurementAttempts: analysis.measurementAttempts,
    bodyBytes: analysis.bodyBytes,
    truncated: analysis.truncated,
    provenanceComplete: analysis.provenanceComplete,
    requestedHost: analysis.requestedHost,
    finalHost: analysis.finalHost,
    hostRelation: analysis.hostRelation
  };
}

function aiPolicyStatusCounts(summary) {
  return {
    explicitlyAllowed: summary.filter((policy) => policy.status === 'explicitly_allowed').length,
    implicitlyAllowed: summary.filter((policy) => ['implicitly_allowed', 'explicit_group_without_complete_allow'].includes(policy.status)).length,
    blocked: summary.filter((policy) => policy.status === 'blocked').length,
    unclear: summary.filter((policy) => policy.status === 'unclear').length,
    technicallyUnavailable: summary.filter((policy) => policy.status === 'technically_unavailable').length
  };
}

function aiBotCheckId(botName) {
  return `geo.robots_mentions_${botName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
}

function eeatSignalSummary() {
  return trust('eeat_signal_summary', 'Trust & Review Signals', 'E-E-A-T technical signal summary', function run(ctx) {
    const totalHtmlPages = htmlPageCount(ctx.db, ctx.run.id);
    const rows = all(ctx.db, `
      SELECT url, pageType, hasAuthorPattern, hasVisibleDate, externalSourceLinksCount, schemaTypesJson, textFactsJson
      FROM pages
      WHERE runId = ? AND ${HTML_WHERE}
      ORDER BY id ASC
      LIMIT 500
    `, [ctx.run.id]);
    if (!rows.length) {
      return makeResult(this, 'NA', {
        finding: 'No HTML page facts are available for E-E-A-T signal review.',
        recommendation: 'Run a crawl or import URL facts before reviewing trust signals.',
        evidence: { totalHtmlPages },
        findingType: 'info',
        confidence: 'low',
        automationCoverage: 'requires_external_data'
      });
    }
    const presentTrustLinks = trustLinkSignals(ctx.db, ctx.run.id);
    const articleRows = rows.filter((row) => row.pageType === 'article');
    const articleRowsMissingVisibleTextProvenance = articleRows.filter((row) => !hasVisibleTextProvenance(row.textFactsJson)).length;
    if (articleRowsMissingVisibleTextProvenance) return availabilityResult(this, 'insufficient_evidence', {
      finding: `${articleRowsMissingVisibleTextProvenance}/${articleRows.length} article row(s) lack visible_text provenance; author/date body matches were excluded from trust assessment.`,
      evidence: { sampledPages: rows.length, articlePages: articleRows.length, articleRowsMissingVisibleTextProvenance, presentTrustLinks },
      requirements: { requiredFacts: ['articlePageClassification', 'visibleTextProvenance', 'authorAndSourceSignals'], missingFacts: ['visibleTextProvenance'], minimumCoverage: 1, canCollectWithTargetedRun: true }
    });
    const articleAuthorRows = articleRows.filter((row) => Number(row.hasAuthorPattern || 0) > 0);
    const articleSourceRows = articleRows.filter((row) => Number(row.externalSourceLinksCount || 0) > 0);
    const schemaRows = rows.filter((row) => /Organization|LocalBusiness|Person/i.test(row.schemaTypesJson || ''));
    const weakArticleRows = articleRows
      .filter((row) => !Number(row.hasAuthorPattern || 0) && !Number(row.externalSourceLinksCount || 0))
      .slice(0, 10);
    const status = weakArticleRows.length ? 'Warning' : 'OK';
    return makeResult(this, status, {
      priority: 'Low',
      affectedCount: weakArticleRows.length,
      sampleUrls: weakArticleRows.map((row) => row.url),
      finding: status === 'Warning'
        ? `${weakArticleRows.length}/${articleRows.length} sampled article page(s) have weak visible author/source signals.`
        : `Technical trust signals were inventoried across ${rows.length} sampled HTML page(s).`,
      recommendation: 'Use this as a technical trust-signal inventory. Final E-E-A-T quality needs editorial or optional LLM review.',
      evidence: {
        sampledPages: rows.length,
        articlePages: articleRows.length,
        articleAuthorSignalPages: articleAuthorRows.length,
        articleExternalSourcePages: articleSourceRows.length,
        schemaTrustSignalPages: schemaRows.length,
        presentTrustLinks,
        weakArticleSamples: weakArticleRows
      },
      findingType: 'best_practice',
      confidence: articleRows.length ? 'medium' : 'low',
      reviewRecommended: true,
      reviewReason: 'E-E-A-T cannot be judged from technical signals alone.',
      dataBasis: 'URL facts, internal trust links, author/source/schema signals',
      evidenceLevel: 'sample',
      automationCoverage: 'requires_human_review',
      interpretation: 'The tool identifies trust signals that can support a human E-E-A-T review.',
      limitations: 'It does not judge topical expertise, factual accuracy or legal compliance.'
    });
  }, { priority: 'Low', effort: 'S' });
}

function trustLinkSignals(db, runId) {
  const rows = all(db, `
    SELECT targetUrl, anchorText
    FROM page_links
    WHERE runId = ? AND linkType = 'internal'
    LIMIT 1000
  `, [runId]);
  const text = rows.map((row) => `${row.targetUrl || ''} ${row.anchorText || ''}`).join('\n').toLowerCase();
  return [
    /impressum|legal notice/.test(text) && 'impressum',
    /datenschutz|privacy/.test(text) && 'privacy',
    /(^|[\/\s-])(about|about-us|ueber|über|unternehmen|company|team)([\/\s-]|$)/.test(text) && 'about_company',
    /kontakt|contact/.test(text) && 'contact'
  ].filter(Boolean);
}

function ymylReviewSignal() {
  return trust('ymyl_review_signal', 'Trust & Review Signals', 'YMYL topical review signal', function run(ctx) {
    const ymylWhere = `(
      LOWER(COALESCE(url, '') || ' ' || COALESCE(title, '')) LIKE '%gesundheit%' OR
      LOWER(COALESCE(url, '') || ' ' || COALESCE(title, '')) LIKE '%health%' OR
      LOWER(COALESCE(url, '') || ' ' || COALESCE(title, '')) LIKE '%krankheit%' OR
      LOWER(COALESCE(url, '') || ' ' || COALESCE(title, '')) LIKE '%tierarzt%' OR
      LOWER(COALESCE(url, '') || ' ' || COALESCE(title, '')) LIKE '%veterinaer%' OR
      LOWER(COALESCE(url, '') || ' ' || COALESCE(title, '')) LIKE '%veterinär%' OR
      LOWER(COALESCE(url, '') || ' ' || COALESCE(title, '')) LIKE '%futterberatung%' OR
      LOWER(COALESCE(url, '') || ' ' || COALESCE(title, '')) LIKE '%ernaehrung%' OR
      LOWER(COALESCE(url, '') || ' ' || COALESCE(title, '')) LIKE '%ernährung%' OR
      LOWER(COALESCE(url, '') || ' ' || COALESCE(title, '')) LIKE '%versicherung%' OR
      LOWER(COALESCE(url, '') || ' ' || COALESCE(title, '')) LIKE '%recht%' OR
      LOWER(COALESCE(url, '') || ' ' || COALESCE(title, '')) LIKE '%law%' OR
      LOWER(COALESCE(url, '') || ' ' || COALESCE(title, '')) LIKE '%finanz%' OR
      LOWER(COALESCE(url, '') || ' ' || COALESCE(title, '')) LIKE '%finance%' OR
      LOWER(COALESCE(url, '') || ' ' || COALESCE(title, '')) LIKE '%medikament%' OR
      LOWER(COALESCE(url, '') || ' ' || COALESCE(title, '')) LIKE '%symptom%'
    )`;
    const rows = all(ctx.db, `
      SELECT url, title, pageType
      FROM pages
      WHERE runId = ? AND ${HTML_WHERE}
        AND ${ymylWhere}
      ORDER BY id ASC
      LIMIT 25
    `, [ctx.run.id]);
    const totalCandidates = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ? AND ${HTML_WHERE}
        AND ${ymylWhere}
    `, [ctx.run.id]);
    return makeResult(this, totalCandidates ? 'Warning' : 'OK', {
      priority: 'Low',
      affectedCount: totalCandidates,
      sampleUrls: rows.map((row) => row.url),
      finding: totalCandidates
        ? `${totalCandidates} sampled/stored page(s) have possible YMYL-sensitive topical signals.`
        : 'No obvious YMYL-sensitive topical signals were detected in stored URL/title facts.',
      recommendation: 'Route possible YMYL pages to human review; optional LLM sampling can help prepare the review but should not replace editorial judgment.',
      evidence: { totalCandidates, samples: rows },
      findingType: 'best_practice',
      confidence: totalCandidates ? 'medium' : 'low',
      reviewRecommended: totalCandidates > 0,
      reviewReason: 'YMYL relevance and content quality require human editorial judgment.',
      dataBasis: 'URL and title keyword heuristics',
      evidenceLevel: 'sample',
      automationCoverage: totalCandidates ? 'requires_human_review' : 'partial',
      interpretation: 'This flags pages that may deserve stronger trust and accuracy review.',
      limitations: 'Keyword heuristics can miss or over-include topics and do not assess correctness.'
    });
  }, { priority: 'Low', effort: 'S' });
}

function markdownTwinCheck() {
  return geo('markdown_twin_homepage', 'GEO Opportunities', 'Markdown Twin für Startseite prüfen', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT type, url, statusCode, LENGTH(content) AS bytes
        , responseHeadersJson, substr(content, 1, 400) AS contentSample
      FROM domain_assets
      WHERE runId = ? AND (
        type IN ('llms', 'llms_full') OR
        url LIKE '%/index.md' OR url LIKE '%/index.md.txt' OR url LIKE '%/README.md'
      )
      ORDER BY url
    `, [ctx.run.id]);
    const enrichedRows = rows.map((row) => {
      const contentType = contentTypeForAsset(ctx, row);
      const markdownLike = isMarkdownLikeAsset(row, contentType);
      return {
        type: row.type,
        url: row.url,
        statusCode: row.statusCode,
        bytes: row.bytes,
        contentType,
        markdownLike
      };
    });
    const okRows = enrichedRows.filter((row) => row.statusCode >= 200 && row.statusCode < 300 && row.markdownLike);
    return makeResult(this, okRows.length ? 'OK' : 'Warning', {
      affectedCount: okRows.length ? 0 : 1,
      finding: okRows.length ? `${okRows.length} Markdown/AI-readable candidate file(s) returned usable 2xx content.` : 'No checked Markdown Twin candidate returned usable 2xx Markdown/text content.',
      recommendation: 'Provide a maintained Markdown twin only when it can stay consistent with canonical HTML.',
      details: 'Candidates must return 2xx and Markdown/text-like content; HTML responses are not counted as Markdown twins.',
      evidence: { checkedFiles: enrichedRows }
    });
  }, { priority: 'Low' });
}

function faqHtmlMissingSchema() {
  return geo('faq_html_present_schema_missing', 'Structured Content', 'FAQ blocks in HTML but FAQPage schema missing', function run(ctx) {
    const rows = all(ctx.db, `
      SELECT url
      FROM pages
      WHERE runId = ? AND hasFaqPattern = 1 AND COALESCE(schemaTypesJson, '') NOT LIKE '%FAQPage%'
      LIMIT 10
    `, [ctx.run.id]);
    const faqPages = count(ctx.db, 'SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND hasFaqPattern = 1', [ctx.run.id]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ? AND hasFaqPattern = 1 AND COALESCE(schemaTypesJson, '') NOT LIKE '%FAQPage%'
    `, [ctx.run.id]);
    const weakFaqPages = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ?
        AND hasFaqPattern = 0
        AND featureFlagsJson LIKE '%"hasWeakFaqPattern":true%'
    `, [ctx.run.id]);
    const weakRows = all(ctx.db, `
      SELECT url
      FROM pages
      WHERE runId = ?
        AND hasFaqPattern = 0
        AND featureFlagsJson LIKE '%"hasWeakFaqPattern":true%'
      LIMIT 10
    `, [ctx.run.id]);
    const status = faqPages ? (affectedCount ? 'Warning' : 'OK') : 'NA';
    return makeResult(this, status, {
      evaluationState: faqPages ? (affectedCount ? 'fail' : 'pass') : weakFaqPages ? 'insufficient_evidence' : 'not_applicable',
      priority: 'Low',
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: faqPages
        ? `${affectedCount}/${faqPages} page(s) with strong FAQ structure lack FAQPage schema.`
        : weakFaqPages
          ? `${weakFaqPages} page(s) have weak FAQ hints; review before treating them as FAQ content.`
          : 'No qualifying FAQ structures detected.',
      recommendation: 'Use FAQPage schema only when the visible content qualifies for it.',
      details: 'GEO perspective: FAQPage can improve answer extraction only when visible Q&A structure is real.',
      evidence: { strongFaqPages: faqPages, weakFaqPages, affectedCount, sampleUrls: rows.map((row) => row.url), weakSampleUrls: weakRows.map((row) => row.url) },
      findingType: faqPages ? 'opportunity' : weakFaqPages ? 'opportunity' : 'info',
      confidence: faqPages ? 'high' : 'low',
      reviewRecommended: weakFaqPages > 0,
      reportGroupingKey: 'schema.faqpage',
      relatedCheckIds: ['tech.faqpage_missing_low_coverage'],
      requirements: {
        requiredFacts: ['strongFaqPageClassification', 'schemaTypeExtraction'],
        optionalFacts: ['weakFaqHints'],
        missingFacts: faqPages ? [] : weakFaqPages ? ['strongFaqPageClassification'] : [],
        minimumCoverage: 1,
        canCollectWithTargetedRun: weakFaqPages > 0,
        reason: faqPages ? 'Strong FAQ page facts were available.' : weakFaqPages ? 'Only weak FAQ hints were observed.' : 'No qualifying FAQ page is in scope.'
      }
    });
  });
}

function signalCoverage(id, category, name, column, label) {
  return geo(id, category, name, function run(ctx) {
    const total = htmlPageCount(ctx.db, ctx.run.id);
    const signalWhere = `${column} = 1`;
    const signalCount = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${signalWhere}`, [ctx.run.id]);
    const status = !total ? 'NA' : signalCount ? 'OK' : 'Warning';
    return makeResult(this, status, {
      affectedCount: status === 'Warning' ? total : 0,
      sampleUrls: signalCount ? sampleUrls(ctx.db, ctx.run.id, signalWhere) : [],
      finding: total ? `${signalCount}/${total} HTML page(s) have ${label} signal(s).` : 'No HTML pages stored.',
      recommendation: `Use ${label} where it naturally improves machine-readable structure.`,
      details: `Based on stored ${column}=1 page signal.`,
      evidence: { totalHtmlPages: total, signalPages: signalCount, signalColumn: column, label }
    });
  }, { priority: 'Low' });
}

function tablesCoverage() {
  return geo('tables_present', 'Content Structure Signals', 'Tables present', function run(ctx) {
    const total = htmlPageCount(ctx.db, ctx.run.id);
    const signalWhere = 'hasTables = 1';
    const signalCount = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND ${signalWhere}`, [ctx.run.id]);
    const status = !total ? 'NA' : signalCount ? 'OK' : 'NA';
    return makeResult(this, status, {
      affectedCount: 0,
      sampleUrls: signalCount ? sampleUrls(ctx.db, ctx.run.id, signalWhere) : [],
      finding: total ? `${signalCount}/${total} HTML page(s) have table signal(s).` : 'No HTML pages stored.',
      recommendation: 'Use tables where tabular comparisons, prices, datasets or specifications are actually present.',
      details: 'Tables are optional structure signals and are not required on every service or landing page.',
      evidence: { totalHtmlPages: total, signalPages: signalCount, signalColumn: 'hasTables', label: 'tables', applicability: signalCount ? 'present' : 'optional_not_detected' },
      findingType: signalCount ? 'info' : 'opportunity',
      confidence: 'high'
    });
  }, { priority: 'Low' });
}

function articleSignalCoverage(id, category, name, column, label) {
  return geo(id, category, name, function run(ctx) {
    const candidateWhere = `${HTML_WHERE} AND (
      COALESCE(pageType, 'other') = 'article' OR
      featureFlagsJson LIKE '%"articleLike":true%'
    )`;
    const total = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND (${candidateWhere})`, [ctx.run.id]);
    const missingNormalizedTextFacts = total ? count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND (${candidateWhere}) AND NOT (${VISIBLE_TEXT_FACTS_WHERE})`, [ctx.run.id]) : 0;
    if (missingNormalizedTextFacts) return availabilityResult(this, 'insufficient_evidence', {
      finding: `${missingNormalizedTextFacts}/${total} article-like candidate(s) lack visible_text provenance; legacy body/script matches were not treated as ${label} evidence.`,
      evidence: { candidatePages: total, missingNormalizedTextFacts, signalColumn: column, normalization: VISIBLE_TEXT_NORMALIZATION_VERSION },
      requirements: { requiredFacts: ['articleLikePageClassification', `${column}Observation`, 'visibleTextProvenance'], optionalFacts: ['editorialPolicy'], missingFacts: ['visibleTextProvenance'], minimumCoverage: 1, canCollectWithTargetedRun: true }
    });
    const signalWhere = `${candidateWhere} AND ${column} = 1`;
    const signalCount = total ? count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND (${signalWhere})`, [ctx.run.id]) : 0;
    const missingWhere = `${candidateWhere} AND COALESCE(${column}, 0) = 0`;
    const missingCount = total ? count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND (${missingWhere})`, [ctx.run.id]) : 0;
    const status = !total ? 'NA' : missingCount ? 'Warning' : 'OK';
    return makeResult(this, status, {
      evaluationState: !total ? 'not_applicable' : missingCount ? 'fail' : 'pass',
      affectedCount: missingCount,
      sampleUrls: missingCount ? sampleUrls(ctx.db, ctx.run.id, missingWhere) : sampleUrls(ctx.db, ctx.run.id, signalWhere),
      finding: total ? `${signalCount}/${total} article-like page(s) have ${label} signal(s).` : `No article-like pages detected for ${label} evaluation.`,
      recommendation: `Use ${label} where it improves editorial provenance, freshness or citation quality.`,
      details: `Evaluated only article-like pages, not every service, legal or landing page.`,
      facts: { candidatePages: total, signalPages: signalCount, missingPages: missingCount, signalColumn: column, label },
      evidence: { source: 'article-like page classification and extracted editorial signals', runId: ctx.run.id, sampleUrls: missingCount ? sampleUrls(ctx.db, ctx.run.id, missingWhere) : [] },
      requirements: { requiredFacts: ['articleLikePageClassification', `${column}Observation`], optionalFacts: ['editorialPolicy'], missingFacts: [], minimumCoverage: 1, canCollectWithTargetedRun: true },
      findingType: status === 'Warning' ? 'opportunity' : 'info',
      confidence: total ? 'high' : 'medium'
    });
  }, { priority: 'Low' });
}

function sourceLinksPresent() {
  return geo('source_or_external_links_present', 'Content Structure', 'Quellenbereiche oder externe Quellenlinks vorhanden', function run(ctx) {
    const candidateWhere = `${HTML_WHERE} AND (
      COALESCE(pageType, 'other') = 'article' OR
      featureFlagsJson LIKE '%"articleLike":true%'
    )`;
    const total = count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND (${candidateWhere})`, [ctx.run.id]);
    const sourcePages = total ? count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND (${candidateWhere}) AND externalSourceLinksCount > 0`, [ctx.run.id]) : 0;
    const missingWhere = `${candidateWhere} AND COALESCE(externalSourceLinksCount, 0) = 0`;
    const missingCount = total ? count(ctx.db, `SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND (${missingWhere})`, [ctx.run.id]) : 0;
    return makeResult(this, !total ? 'NA' : sourcePages ? 'OK' : 'Warning', {
      evaluationState: !total ? 'not_applicable' : sourcePages ? 'pass' : 'fail',
      affectedCount: missingCount,
      sampleUrls: missingCount ? sampleUrls(ctx.db, ctx.run.id, missingWhere) : [],
      finding: total ? `${sourcePages}/${total} article-like page(s) include external/source-link signals.` : 'No article-like pages detected for source-link evaluation.',
      recommendation: 'Use external source links where claims depend on citeable references.',
      details: 'Source links are evaluated on article-like pages only; generic service pages are not expected to cite external sources by default.',
      facts: { candidatePages: total, sourceSignalPages: sourcePages, missingPages: missingCount },
      evidence: { source: 'article-like page classification and external/source-link extraction', runId: ctx.run.id },
      requirements: { requiredFacts: ['articleLikePageClassification', 'externalSourceLinkObservation'], optionalFacts: ['claimCitationNeed'], missingFacts: [], minimumCoverage: 1, canCollectWithTargetedRun: true },
      findingType: total ? 'opportunity' : 'info',
      confidence: total ? 'high' : 'medium'
    });
  }, { priority: 'Low' });
}

function internalNavLink(id, category, name, needles) {
  return geo(id, category, name, function run(ctx) {
    if (!Boolean(ctx.run.storeAllLinks)) {
      return availabilityResult(this, 'not_executed', {
        finding: `${name}: normalized link rows were not retained, so no absence was inferred.`,
        details: 'Aggregate link counts cannot prove whether a specific trust/contact destination was linked.',
        recommendation: 'Repeat a small targeted crawl with storeAllLinks enabled if navigation evidence is required.',
        facts: { storeAllLinks: false },
        evidence: { storageProfile: ctx.run.storageProfile, runId: ctx.run.id },
        requirements: { requiredFacts: ['normalizedInternalLinkRows'], missingFacts: ['normalizedInternalLinkRows'], canCollectWithTargetedRun: true }
      });
    }
    const total = htmlPageCount(ctx.db, ctx.run.id);
    if (!total) {
      return makeResult(this, 'NA', {
        finding: `${name}: no HTML pages stored.`,
        evidence: { totalHtmlPages: 0, needles }
      });
    }
    const truncatedPages = count(ctx.db, 'SELECT COUNT(*) AS count FROM pages WHERE runId = ? AND COALESCE(linkRowsTruncated, 0) = 1', [ctx.run.id]);
    const renderedOnlyLinkPages = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ?
        AND renderStatus = 'success'
        AND COALESCE(renderedLinksCount, 0) > COALESCE(internalLinksCount, 0)
    `, [ctx.run.id]);
    if (id === 'about_linked') {
      const candidates = all(ctx.db, `
        SELECT sourceUrl, sourceUrl AS url, targetUrl, anchorText
        FROM page_links
        WHERE runId = ? AND linkType = 'internal'
        ORDER BY id ASC
        LIMIT 500
      `, [ctx.run.id]);
      const matched = [];
      for (const row of candidates) {
        const match = matchAboutLink(row);
        if (!match) continue;
        matched.push({ ...row, matchedNeedle: match.matchedNeedle, matchSource: match.matchSource });
      }
      const samples = dedupeLinkSamples(matched, 10);
      if (!samples.length && truncatedPages) return availabilityResult(this, 'insufficient_evidence', {
        finding: `No clear about/company link was retained, but link rows were truncated on ${truncatedPages} page(s).`,
        details: 'A retained link sample cannot prove absence when one or more page-level link inventories were truncated.',
        recommendation: 'Repeat a small targeted run with debug link retention or a navigation-focused extractor if this signal is required.',
        facts: { totalHtmlPages: total, truncatedPages, retainedMatches: 0 },
        evidence: { runId: ctx.run.id, storageProfile: ctx.run.storageProfile, linkRowsTruncated: true },
        requirements: { requiredFacts: ['completeInternalLinkRows'], missingFacts: ['completeInternalLinkRows'], minimumCoverage: 1, canCollectWithTargetedRun: true }
      });
      if (!samples.length && renderedOnlyLinkPages) return availabilityResult(this, 'insufficient_evidence', {
        finding: `No clear about/company link was present in raw retained links, while ${renderedOnlyLinkPages} rendered page(s) added links without retained rendered-link details.`,
        details: 'Raw link absence cannot prove navigation absence when rendering adds links and only rendered counts were retained.',
        recommendation: 'Repeat a small browser run with rendered-link detail retention if this signal is required.',
        facts: { totalHtmlPages: total, renderedOnlyLinkPages, retainedRawMatches: 0 },
        evidence: { runId: ctx.run.id, renderedLinksCountAvailable: true, renderedLinkDetailsAvailable: false },
        requirements: { requiredFacts: ['completeRenderedInternalLinkRows'], missingFacts: ['renderedInternalLinkRows'], minimumCoverage: 1, canCollectWithTargetedRun: true }
      });
      return makeResult(this, samples.length ? 'OK' : 'Warning', {
        affectedCount: samples.length ? 0 : 1,
        sampleUrls: samples.map((row) => row.sourceUrl || row.url),
        finding: samples.length ? `${samples.length} clear about/company internal link sample(s) found.` : 'No clear about/company internal link found in crawled pages.',
        recommendation: 'Expose the about, company or team page through a crawlable internal link.',
        details: 'Matches require a clear target URL pattern or a concise about/company/team anchor, not incidental body-like anchor text.',
        evidence: {
          strongTargetPatterns: ABOUT_TARGET_PATTERNS.map((item) => item.needle),
          strongAnchorLabels: ABOUT_ANCHOR_LABELS,
          matchedNeedle: samples[0]?.matchedNeedle || null,
          matchSource: samples[0]?.matchSource || null,
          samples
        },
        requirements: { requiredFacts: ['normalizedInternalLinkRows'], optionalFacts: ['navigationRegion'], missingFacts: [], minimumCoverage: 1, canCollectWithTargetedRun: true }
      });
    }
    const conditions = needles.map(() => '(LOWER(targetUrl) LIKE ? OR LOWER(anchorText) LIKE ?)').join(' OR ');
    const params = needles.flatMap((needle) => [`%${needle.toLowerCase()}%`, `%${needle.toLowerCase()}%`]);
    const rows = dedupeLinkSamples(all(ctx.db, `
      SELECT sourceUrl, sourceUrl AS url, targetUrl, anchorText
      FROM page_links
      WHERE runId = ? AND linkType = 'internal' AND (${conditions})
      LIMIT 30
    `, [ctx.run.id, ...params]));
    if (!rows.length && truncatedPages) return availabilityResult(this, 'insufficient_evidence', {
      finding: `No matching link was retained, but link rows were truncated on ${truncatedPages} page(s).`,
      details: 'A retained link sample cannot prove absence when one or more page-level link inventories were truncated.',
      recommendation: 'Repeat a small targeted run with debug link retention or a navigation-focused extractor if this signal is required.',
      facts: { totalHtmlPages: total, truncatedPages, retainedMatches: 0, needles },
      evidence: { runId: ctx.run.id, storageProfile: ctx.run.storageProfile, linkRowsTruncated: true },
      requirements: { requiredFacts: ['completeInternalLinkRows'], missingFacts: ['completeInternalLinkRows'], minimumCoverage: 1, canCollectWithTargetedRun: true }
    });
    if (!rows.length && renderedOnlyLinkPages) return availabilityResult(this, 'insufficient_evidence', {
      finding: `No matching link was present in raw retained links, while ${renderedOnlyLinkPages} rendered page(s) added links without retained rendered-link details.`,
      details: 'Raw link absence cannot prove navigation absence when rendering adds links and only rendered counts were retained.',
      recommendation: 'Repeat a small browser run with rendered-link detail retention if this signal is required.',
      facts: { totalHtmlPages: total, renderedOnlyLinkPages, retainedRawMatches: 0, needles },
      evidence: { runId: ctx.run.id, renderedLinksCountAvailable: true, renderedLinkDetailsAvailable: false },
      requirements: { requiredFacts: ['completeRenderedInternalLinkRows'], missingFacts: ['renderedInternalLinkRows'], minimumCoverage: 1, canCollectWithTargetedRun: true }
    });
    return makeResult(this, rows.length ? 'OK' : 'Warning', {
      affectedCount: rows.length ? 0 : 1,
      sampleUrls: rows.map((row) => row.sourceUrl || row.url),
      finding: rows.length ? `${rows.length} matching internal link sample(s) found.` : 'No matching internal link found in crawled pages.',
      recommendation: 'Expose important trust/contact pages through crawlable internal links.',
      evidence: { needles, samples: rows },
      requirements: { requiredFacts: ['normalizedInternalLinkRows'], optionalFacts: ['navigationRegion'], missingFacts: [], minimumCoverage: 1, canCollectWithTargetedRun: true }
    });
  }, { priority: 'Low' });
}

function organizationSameAs() {
  return geo('organization_schema_sameas', 'Structured Data', 'Organization Schema mit sameAs vorhanden', function run(ctx) {
    const rows = all(ctx.db, "SELECT pageUrl AS url, rawJson, propertiesJson FROM schemas WHERE runId = ? AND schemaType = 'Organization'", [ctx.run.id]);
    if (!rows.length) {
      return availabilityResult(this, 'not_applicable', {
        finding: 'No Organization schema block was observed, so sameAs completeness was not assessed.',
        details: 'sameAs is conditional on an Organization entity and verified official profiles.',
        recommendation: 'Evaluate Organization schema separately before considering sameAs.',
        facts: { organizationBlocks: 0 },
        evidence: { schemaType: 'Organization', runId: ctx.run.id },
        requirements: { requiredFacts: ['organizationSchemaBlock'], missingFacts: [], canCollectWithTargetedRun: false, reason: 'The check is not applicable without an Organization block.' },
        scoreDeduplicationKey: 'organization.same_as'
      });
    }
    if (!rows.some((row) => safeJson(row.propertiesJson, []).length || row.rawJson !== null && row.rawJson !== undefined)) {
      return availabilityResult(this, 'insufficient_evidence', {
        finding: 'Organization schema was observed, but retained schema properties are insufficient to assess sameAs.',
        details: 'Missing retained raw JSON is not evidence that the property is absent.',
        recommendation: 'Repeat a small targeted run with schema-property retention if sameAs is in scope.',
        facts: { organizationBlocks: rows.length, schemaPropertyPayloadAvailable: false },
        evidence: { storageProfile: ctx.run.storageProfile, schemaType: 'Organization' },
        requirements: { requiredFacts: ['organizationSchemaProperties'], missingFacts: ['organizationSchemaProperties'], canCollectWithTargetedRun: true },
        scoreDeduplicationKey: 'organization.same_as'
      });
    }
    const matches = rows.filter((row) => safeJson(row.propertiesJson, []).includes('sameAs') || /"sameAs"\s*:/.test(row.rawJson || ''));
    return makeResult(this, matches.length ? 'OK' : 'Warning', {
      affectedCount: matches.length ? 0 : 1,
      sampleUrls: matches.map((row) => row.url),
      finding: matches.length ? 'Organization schema with sameAs found.' : 'Organization schema with sameAs not found.',
      recommendation: 'Add sameAs only for verified official profiles.',
      evidence: { organizationBlocks: rows.length, sameAsBlocks: matches.length, sampleUrls: matches.map((row) => row.url).slice(0, 10) },
      requirements: { requiredFacts: ['organizationSchemaBlock', 'organizationSchemaProperties'], optionalFacts: ['verifiedOfficialProfiles'], missingFacts: [], minimumCoverage: 1, canCollectWithTargetedRun: true },
      scoreDeduplicationKey: 'organization.same_as',
      reportGroupingKey: 'organization.same_as'
    });
  }, { priority: 'Low' });
}

function schemaPresence(id, category, name, schemaType, priority = 'Medium') {
  return geo(id, category, name, function run(ctx) {
    const total = htmlPageCount(ctx.db, ctx.run.id);
    if (!total) {
      return makeResult(this, 'NA', {
        finding: `${schemaType} schema could not be evaluated because no HTML pages were stored.`,
        evidence: { totalHtmlPages: 0, schemaType }
      });
    }
    const rows = all(ctx.db, `
      SELECT DISTINCT pageUrl AS url
      FROM schemas
      WHERE runId = ? AND schemaType = ? AND parseStatus = 'ok'
      LIMIT 10
    `, [ctx.run.id, schemaType]);
    if (!rows.length && schemaType === 'SpeakableSpecification') {
      return availabilityResult(this, 'not_applicable', {
        finding: 'Speakable schema is not present; this optional, page-type-dependent opportunity was excluded from scoring.',
        details: 'No page type or editorial workflow was established that makes SpeakableSpecification necessary.',
        recommendation: 'Use SpeakableSpecification only where it accurately matches visible speakable content and a supported use case.',
        facts: { totalHtmlPages: total, schemaType, matchingPages: 0 },
        evidence: { schemaType, sampleUrls: [] },
        requirements: { requiredFacts: ['applicableSpeakableUseCase'], missingFacts: [], canCollectWithTargetedRun: false, reason: 'No applicable use case was established.' },
        scoreDeduplicationKey: 'schema.speakable',
        reportGroupingKey: 'schema.speakable',
        relatedCheckIds: ['tech.speakable_missing']
      });
    }
    return makeResult(this, rows.length ? 'OK' : 'Warning', {
      affectedCount: rows.length ? 0 : 1,
      sampleUrls: rows.map((row) => row.url),
      finding: rows.length ? `${schemaType} schema found.` : `${schemaType} schema not found.`,
      recommendation: `Use ${schemaType} schema where it accurately matches visible content.`,
      evidence: { schemaType, sampleUrls: rows.map((row) => row.url) },
      requirements: { requiredFacts: ['htmlPageFacts', 'schemaTypeExtraction'], optionalFacts: ['applicablePageType'], missingFacts: [], minimumCoverage: 1, canCollectWithTargetedRun: true },
      reportGroupingKey: schemaType === 'SpeakableSpecification' ? 'schema.speakable' : undefined,
      relatedCheckIds: schemaType === 'SpeakableSpecification' ? ['tech.speakable_missing'] : [],
      findingType: schemaType === 'SpeakableSpecification' ? 'opportunity' : undefined,
      confidence: schemaType === 'SpeakableSpecification' ? 'medium' : 'high'
    });
  }, { priority });
}

function breadcrumbPresence() {
  return geo('breadcrumblist_present', 'Structured Data', 'BreadcrumbList vorhanden', function run(ctx) {
    const candidateWhere = `
      ${HTML_WHERE}
      AND COALESCE(pageType, 'other') NOT IN ('homepage', 'blog_index', 'article_index', 'product_index', 'category_index', 'legal', 'contact')
      AND (
        COALESCE(pageType, 'other') IN ('article', 'product', 'category', 'location')
        OR LOWER(url) LIKE '%/fakta/%'
        OR LOWER(url) LIKE '%/fakten/%'
        OR LOWER(url) LIKE '%/facts/%'
        OR depth > 1
      )`;
    const candidatePages = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ? AND (${candidateWhere})
    `, [ctx.run.id]);
    const rows = all(ctx.db, `
      SELECT url
      FROM pages
      WHERE runId = ? AND (${candidateWhere})
        AND COALESCE(schemaTypesJson, '') LIKE '%BreadcrumbList%'
      LIMIT 10
    `, [ctx.run.id]);
    const pagesWithBreadcrumbList = rows.length ? count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ? AND (${candidateWhere})
        AND COALESCE(schemaTypesJson, '') LIKE '%BreadcrumbList%'
    `, [ctx.run.id]) : 0;
    const coverage = candidatePages ? pagesWithBreadcrumbList / candidatePages : null;
    return makeResult(this, candidatePages ? (rows.length ? 'OK' : 'Warning') : 'NA', {
      affectedCount: candidatePages && !rows.length ? candidatePages : 0,
      sampleUrls: rows.map((row) => row.url),
      finding: candidatePages ? `${pagesWithBreadcrumbList}/${candidatePages} eligible deeper page(s) include BreadcrumbList schema; ${rows.length} sample URL(s) shown.` : 'No deeper eligible pages detected.',
      recommendation: 'Use BreadcrumbList where visible breadcrumbs exist on deeper templates.',
      details: 'Homepage, index, legal and contact pages are excluded from this GEO signal.',
      evidence: { eligiblePages: candidatePages, pagesWithBreadcrumbList, coverage, samplePresentUrls: rows.map((row) => row.url) },
      findingType: 'opportunity',
      confidence: 'high'
    });
  }, { priority: 'Low' });
}

function articleBlogWithArticleSchema() {
  return geo('article_blog_pages_article_schema', 'Structured Data', 'Article/Blog-Seiten mit Article Schema', function run(ctx) {
    const { candidates, scopeUnavailable, uncertain, evaluable, missing } = evaluatePageTypeSchemaCoverage(ctx.db, ctx.run.id, 'article', 'Article');
    const rows = missing.slice(0, 10);
    const candidateCount = candidates.length;
    const incompleteCandidates = uncertain.length + scopeUnavailable.length;
    if (incompleteCandidates && !missing.length) return availabilityResult(this, 'insufficient_evidence', {
      finding: `${evaluable.length}/${candidateCount + scopeUnavailable.length} stored article candidate(s) have complete scope and classification evidence; ${incompleteCandidates} incomplete candidate(s) were excluded.`,
      evidence: { candidateCount, evaluableCandidates: evaluable.length, uncertainCandidates: uncertain.length, unknownIndexabilityCandidates: scopeUnavailable.length, acceptedSchemaFamily: 'Article', typeHierarchyVersion: SCHEMA_TYPE_HIERARCHY_VERSION, uncertainSamples: [...uncertain, ...scopeUnavailable].slice(0, 10).map((row) => row.url), coverageLogicVersion: STRUCTURED_DATA_COVERAGE_LOGIC_VERSION },
      requirements: { requiredFacts: ['reliableArticlePageClassification', 'schemaTypeExtraction', 'indexability'], missingFacts: [...(uncertain.length ? ['reliableArticlePageClassification'] : []), ...(scopeUnavailable.length ? ['indexability'] : [])], minimumCoverage: 1, canCollectWithTargetedRun: true },
      reportGroupingKey: 'schema.article',
      rootCauseKey: 'structured_data.article_coverage',
      rootCauseFamily: 'structured_data.article',
      scopeType: 'template',
      relatedCheckIds: ['tech.article_coverage_on_article_like_pages']
    });
    const status = candidateCount ? (rows.length ? 'Warning' : 'OK') : 'NA';
    return makeResult(this, status, {
      affectedCount: missing.length,
      sampleUrls: rows.map((row) => row.url),
      finding: candidateCount ? `${missing.length}/${evaluable.length} evaluable article page(s) lack an Article-compatible schema type.` : 'No unambiguous, successful, indexable article pages were detected.',
      recommendation: 'Use Article schema on qualifying editorial pages.',
      details: "Evaluated only pages classified as pageType='article'.",
      evidence: { candidateCount, evaluableCandidates: evaluable.length, uncertainCandidates: uncertain.length, unknownIndexabilityCandidates: scopeUnavailable.length, affectedCount: missing.length, displayedSamples: rows.length, acceptedSchemaFamily: 'Article', typeHierarchyVersion: SCHEMA_TYPE_HIERARCHY_VERSION, propertyCompletenessEvaluated: false, missingArticleSchemaSamples: rows.map((row) => row.url), coverageLogicVersion: STRUCTURED_DATA_COVERAGE_LOGIC_VERSION },
      requirements: { requiredFacts: ['reliableArticlePageClassification', 'schemaTypeExtraction', 'indexability'], optionalFacts: ['stableRenderedSchemaWhenRenderRequired'], missingFacts: [...(uncertain.length ? ['reliableArticlePageClassification'] : []), ...(scopeUnavailable.length ? ['indexability'] : [])], minimumCoverage: 1, canCollectWithTargetedRun: true },
      findingType: 'opportunity',
      scoreEligible: false,
      scoreExclusionReason: 'The technical Article coverage check owns the shared scoring unit; GEO keeps a review perspective without a second penalty.',
      evaluationState: !candidateCount ? 'not_applicable' : missing.length ? 'fail' : 'pass',
      confidence: incompleteCandidates ? 'medium' : candidateCount >= 20 ? 'high' : candidateCount ? 'medium' : 'low',
      reviewRecommended: missing.length > 0,
      reviewReason: missing.length ? 'Article schema is optional for general indexing and its value depends on the editorial template and implementation goals.' : null,
      reportGroupingKey: 'schema.article',
      rootCauseKey: 'structured_data.article_coverage',
      rootCauseFamily: 'structured_data.article',
      scopeType: 'template',
      relatedCheckIds: ['tech.article_coverage_on_article_like_pages']
    });
  });
}

function lowStructuredSections() {
  return geo('low_structured_sections', 'Content Structure', 'Seiten mit wenig strukturierten Abschnitten markieren', function run(ctx) {
    const legacySignals = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ? AND featureFlagsJson LIKE '%"lowStructuredSections":true%' AND NOT (${VISIBLE_TEXT_FACTS_WHERE})
    `, [ctx.run.id]);
    if (legacySignals) return availabilityResult(this, 'insufficient_evidence', {
      finding: `${legacySignals} low-structure signal(s) lack visible_text provenance; script/hydration text was not accepted as visible content evidence.`,
      evidence: { legacySignals, normalization: VISIBLE_TEXT_NORMALIZATION_VERSION },
      requirements: { requiredFacts: ['visibleTextProvenance', 'headingAndListStructure'], missingFacts: ['visibleTextProvenance'], minimumCoverage: 1, canCollectWithTargetedRun: true }
    });
    const rows = all(ctx.db, `
      SELECT url
      FROM pages
      WHERE runId = ? AND featureFlagsJson LIKE '%"lowStructuredSections":true%'
      LIMIT 10
    `, [ctx.run.id]);
    const affectedCount = count(ctx.db, `
      SELECT COUNT(*) AS count
      FROM pages
      WHERE runId = ? AND featureFlagsJson LIKE '%"lowStructuredSections":true%'
    `, [ctx.run.id]);
    return makeResult(this, affectedCount ? 'Warning' : 'OK', {
      affectedCount,
      sampleUrls: rows.map((row) => row.url),
      finding: affectedCount ? `${affectedCount} page(s) have low structured-section signals.` : 'No low-structure pages detected by stored heuristics.',
      recommendation: 'Add meaningful headings, lists or tables only where they improve content structure.',
      evidence: { affectedCount, sampleUrls: rows.map((row) => row.url) }
    });
  }, { priority: 'Low' });
}

function matchAboutLink(row) {
  const targetPath = normalizedPath(row.targetUrl);
  for (const item of ABOUT_TARGET_PATTERNS) {
    if (item.pattern.test(targetPath)) return { matchedNeedle: item.needle, matchSource: 'targetUrl' };
  }
  const anchor = normalizeAnchor(row.anchorText);
  if (ABOUT_ANCHOR_LABELS.includes(anchor)) {
    return { matchedNeedle: anchor, matchSource: 'anchor' };
  }
  return null;
}

function normalizedPath(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    return safeDecode(new URL(input).pathname).toLowerCase().replace(/\/+$/, '') || '/';
  } catch {
    const withoutQuery = input.split(/[?#]/)[0] || '';
    return safeDecode(withoutQuery).toLowerCase().replace(/\/+$/, '') || '/';
  }
}

function normalizeAnchor(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[|:;,.!?]+$/g, '')
    .trim();
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return String(value || '');
  }
}

function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
