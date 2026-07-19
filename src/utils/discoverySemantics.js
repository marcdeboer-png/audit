import zlib from 'node:zlib';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const ROBOTS_SITEMAP_VALIDATION_VERSION = 'robots-sitemap-validation-v1';
export const SITEMAP_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
export const SITEMAP_MAX_LOCATIONS = 50_000;

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  processEntities: true
});

export function analyzeRobotsAsset(asset = {}) {
  const statusCode = numberOrNull(asset.statusCode);
  const metadata = parseJson(asset.metadataJson, {});
  const content = String(asset.content ?? '');
  const contentType = String(metadata.contentType || headerValue(asset.responseHeadersJson, 'content-type') || '').toLowerCase();
  const looksHtml = /<\s*!doctype\s+html|<\s*html(?:\s|>)/i.test(content.slice(0, 4096));
  const initialStatusCode = numberOrNull(metadata.initialStatusCode) ?? statusCode;
  const finalStatusCode = numberOrNull(metadata.finalStatusCode) ?? statusCode;
  const redirectChain = Array.isArray(metadata.redirectChain) ? metadata.redirectChain : [];
  const base = {
    logicVersion: ROBOTS_SITEMAP_VALIDATION_VERSION,
    url: asset.url || null,
    initialStatusCode,
    finalStatusCode,
    finalUrl: metadata.finalUrl || asset.url || null,
    redirectChain,
    contentType,
    bodyBytes: Buffer.byteLength(content),
    looksHtml,
    fetchError: metadata.fetchError || parseJson(asset.responseHeadersJson, {}).error || null
  };

  if (statusCode === null) return { ...base, state: 'technical_error', crawlDefault: 'unknown' };
  if (statusCode === 429 || statusCode >= 500) return { ...base, state: 'temporarily_unreachable', crawlDefault: 'unknown' };
  if (statusCode >= 400 && statusCode < 500) return { ...base, state: 'absent', crawlDefault: 'allowed' };
  if (statusCode < 200 || statusCode >= 300) return { ...base, state: 'unexpected_status', crawlDefault: 'unknown' };
  if (looksHtml) return { ...base, state: 'invalid_html_representation', crawlDefault: 'unknown' };
  if (!content.trim()) return { ...base, state: 'valid_empty', crawlDefault: 'allowed' };
  return { ...base, state: 'valid', crawlDefault: 'rules_apply' };
}

export function extractRobotsDirectives(content = '') {
  const directives = [];
  for (const [index, rawLine] of String(content).replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = stripRobotsComment(rawLine).trim();
    if (!line || !line.includes(':')) continue;
    const separator = line.indexOf(':');
    directives.push({
      line: index + 1,
      name: line.slice(0, separator).trim().toLowerCase(),
      value: line.slice(separator + 1).trim()
    });
  }
  return directives;
}

export function extractSitemapDirectives(content = '', robotsUrl = null) {
  const seen = new Set();
  const output = [];
  for (const directive of extractRobotsDirectives(content).filter((item) => item.name === 'sitemap')) {
    let normalizedUrl = null;
    let valid = false;
    try {
      const parsed = new URL(directive.value);
      valid = ['http:', 'https:'].includes(parsed.protocol) && Boolean(parsed.hostname);
      if (valid) {
        parsed.hash = '';
        normalizedUrl = parsed.toString();
      }
    } catch {
      valid = false;
    }
    const key = normalizedUrl || `invalid:${directive.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      ...directive,
      valid,
      normalizedUrl,
      sameHost: valid && robotsUrl ? safeHostname(normalizedUrl) === safeHostname(robotsUrl) : null
    });
  }
  return output;
}

export function extractValidSitemapUrls(content = '', robotsUrl = null) {
  return extractSitemapDirectives(content, robotsUrl)
    .filter((item) => item.valid)
    .map((item) => item.normalizedUrl);
}

export function decodeSitemapPayload(payload, url, maxUncompressedBytes = SITEMAP_MAX_UNCOMPRESSED_BYTES) {
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
  // Runtime fetch may already decompress a .gz response while retaining the URL
  // suffix. The gzip magic bytes, not the suffix alone, decide decompression.
  const gzip = buffer.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]));
  if (!gzip) {
    if (buffer.length > maxUncompressedBytes) {
      return { ok: false, error: 'uncompressed_size_limit_exceeded', buffer: null, compressedBytes: buffer.length, uncompressedBytes: buffer.length };
    }
    return { ok: true, error: null, buffer, compressedBytes: buffer.length, uncompressedBytes: buffer.length };
  }
  try {
    const decoded = zlib.gunzipSync(buffer, { maxOutputLength: maxUncompressedBytes });
    return { ok: true, error: null, buffer: decoded, compressedBytes: buffer.length, uncompressedBytes: decoded.length };
  } catch (error) {
    const limit = /larger than|output length|buffer too large/i.test(error.message || '');
    return { ok: false, error: limit ? 'uncompressed_size_limit_exceeded' : 'gzip_decode_failed', message: error.message, buffer: null, compressedBytes: buffer.length, uncompressedBytes: null };
  }
}

export function parseSitemapDocument(payload, options = {}) {
  const decoded = decodeSitemapPayload(payload, options.url, options.maxUncompressedBytes);
  const base = {
    logicVersion: ROBOTS_SITEMAP_VALIDATION_VERSION,
    compressedBytes: decoded.compressedBytes,
    uncompressedBytes: decoded.uncompressedBytes,
    maxUncompressedBytes: options.maxUncompressedBytes || SITEMAP_MAX_UNCOMPRESSED_BYTES
  };
  if (!decoded.ok) return { ...base, valid: false, documentType: 'invalid', parseError: decoded.error, locations: [] };
  const xml = decoded.buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (!xml.trim()) return { ...base, valid: false, documentType: 'empty', parseError: 'empty_document', locations: [] };
  if (/<!DOCTYPE/i.test(xml)) return { ...base, valid: false, documentType: 'invalid', parseError: 'doctype_not_allowed', locations: [] };
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    return { ...base, valid: false, documentType: /<\s*html(?:\s|>)/i.test(xml.slice(0, 4096)) ? 'html' : 'invalid', parseError: compactXmlError(validation), locations: [] };
  }
  let parsed;
  try {
    parsed = XML_PARSER.parse(xml);
  } catch (error) {
    return { ...base, valid: false, documentType: 'invalid', parseError: error.message, locations: [] };
  }
  const hasRoot = (name) => parsed && Object.prototype.hasOwnProperty.call(parsed, name);
  const root = hasRoot('urlset') ? 'urlset' : hasRoot('sitemapindex') ? 'sitemapindex' : hasRoot('html') ? 'html' : 'unsupported_root';
  if (!['urlset', 'sitemapindex'].includes(root)) {
    return { ...base, valid: false, documentType: root, parseError: `unsupported_root:${Object.keys(parsed || {})[0] || 'unknown'}`, locations: [] };
  }
  const entries = root === 'urlset' ? arrayify(parsed.urlset.url) : arrayify(parsed.sitemapindex.sitemap);
  const locations = entries.map((entry) => String(entry?.loc ?? '').trim()).filter(Boolean);
  const uniqueLocations = [...new Set(locations)];
  return {
    ...base,
    valid: true,
    documentType: root,
    parseError: null,
    locations,
    uniqueLocations,
    locationCount: locations.length,
    uniqueLocationCount: uniqueLocations.length,
    duplicateLocationCount: locations.length - uniqueLocations.length,
    protocolLimitExceeded: locations.length > SITEMAP_MAX_LOCATIONS
  };
}

export function sitemapMetadata(asset = {}) {
  const metadata = parseJson(asset.metadataJson, {});
  if (metadata.sitemap) return metadata.sitemap;
  if (asset.statusCode >= 200 && asset.statusCode < 300 && asset.content !== null && asset.content !== undefined) {
    const parsed = parseSitemapDocument(asset.content, { url: asset.url });
    return {
      documentType: parsed.documentType,
      valid: parsed.valid,
      parseError: parsed.parseError,
      locationCount: parsed.locationCount || 0,
      uniqueLocationCount: parsed.uniqueLocationCount || 0,
      duplicateLocationCount: parsed.duplicateLocationCount || 0,
      protocolLimitExceeded: Boolean(parsed.protocolLimitExceeded),
      historicalReconstruction: true
    };
  }
  return { documentType: 'unavailable', valid: false, parseError: null, historicalReconstruction: true };
}

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function stripRobotsComment(line) {
  const index = String(line).indexOf('#');
  return index >= 0 ? String(line).slice(0, index) : String(line);
}

function arrayify(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function compactXmlError(value) {
  const error = value?.err || value;
  return [error?.code, error?.msg, error?.line ? `line:${error.line}` : null].filter(Boolean).join('|') || 'invalid_xml';
}

function safeHostname(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return null; }
}

function headerValue(value, key) {
  return parseJson(value, {})?.[key] || null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
