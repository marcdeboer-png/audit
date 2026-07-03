import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { thresholds } from '../checks/config/thresholds.js';
import { normalizeUrl } from '../utils/url.js';

const SUPPORTED_TARGETED_JOB_TYPES = new Set([
  'title_facts',
  'meta_description_facts',
  'h1_facts',
  'canonical_robots_facts'
]);

export function isSupportedTargetedJobType(jobType) {
  return SUPPORTED_TARGETED_JOB_TYPES.has(jobType);
}

export function supportedTargetedJobTypes() {
  return [...SUPPORTED_TARGETED_JOB_TYPES];
}

export function extractTargetedFacts(jobType, html, context = {}) {
  if (!isSupportedTargetedJobType(jobType)) {
    throw new Error(`Evidence job type is not executable in Batch 10.8: ${jobType}`);
  }
  const $ = cheerio.load(html || '');
  const url = normalizeUrl(context.url) || context.url;
  const finalUrl = normalizeUrl(context.finalUrl || url) || url;
  const statusCode = Number(context.statusCode || 0) || null;
  const contentType = context.contentType || '';
  const metaRobots = cleanText($('meta[name="robots"], meta[name="googlebot"]').first().attr('content'));
  const xRobotsTag = cleanText(context.headers?.['x-robots-tag']);
  const robots = `${metaRobots || ''} ${xRobotsTag || ''}`.toLowerCase();
  const metaNoindex = hasDirective(metaRobots, 'noindex') || hasDirective(metaRobots, 'none');
  const metaNofollow = hasDirective(metaRobots, 'nofollow') || hasDirective(metaRobots, 'none');
  const xRobotsNoindex = hasDirective(xRobotsTag, 'noindex') || hasDirective(xRobotsTag, 'none');
  const xRobotsNofollow = hasDirective(xRobotsTag, 'nofollow') || hasDirective(xRobotsTag, 'none');
  const indexability = indexabilityFor({ statusCode, contentType, metaNoindex, xRobotsNoindex });
  const base = { url, finalUrl, statusCode, contentType, indexability };

  if (jobType === 'title_facts') return { ...base, ...titleFacts($) };
  if (jobType === 'meta_description_facts') return { ...base, ...metaDescriptionFacts($) };
  if (jobType === 'h1_facts') return { ...base, ...h1Facts($) };
  const output = {
    ...base,
    ...canonicalRobotsFacts($, finalUrl, {
      metaRobots,
      metaNoindex,
      metaNofollow,
      xRobotsTag,
      xRobotsNoindex,
      xRobotsNofollow,
      robots
    })
  };
  if (!output.indexability) output.indexability = indexability;
  return output;
}

export function factStorageEstimate(facts = {}) {
  return Buffer.byteLength(JSON.stringify(facts), 'utf8');
}

function titleFacts($) {
  const titleNode = $('head > title').first();
  const hasTitleTag = titleNode.length > 0;
  const title = capText(cleanText(titleNode.text()), 300);
  const titleLength = title ? title.length : 0;
  return {
    title,
    titleLength,
    titleMissing: !hasTitleTag,
    titleEmpty: hasTitleTag && titleLength === 0,
    titleTooShort: titleLength > 0 && titleLength < thresholds.titleTooShort,
    titleTooLong: titleLength > thresholds.titleTooLong,
    titleHash: hashText(title),
    titlePattern: patternForText(title)
  };
}

function metaDescriptionFacts($) {
  const metaNode = $('meta[name="description"]').first();
  const hasMetaTag = metaNode.length > 0;
  const metaDescription = capText(cleanText(metaNode.attr('content')), 500);
  const metaDescriptionLength = metaDescription ? metaDescription.length : 0;
  return {
    metaDescription,
    metaDescriptionLength,
    metaDescriptionMissing: !hasMetaTag,
    metaDescriptionEmpty: hasMetaTag && metaDescriptionLength === 0,
    metaDescriptionTooShort: metaDescriptionLength > 0 && metaDescriptionLength < thresholds.descriptionTooShort,
    metaDescriptionTooLong: metaDescriptionLength > thresholds.descriptionTooLong,
    metaDescriptionHash: hashText(metaDescription),
    metaDescriptionPattern: patternForText(metaDescription)
  };
}

function h1Facts($) {
  const h1Nodes = $('h1');
  const rawTexts = h1Nodes
    .map((_, element) => capText(cleanText($(element).text()), 300))
    .get()
    .slice(0, 20);
  const h1Texts = rawTexts.filter((text) => text !== null);
  const firstH1 = h1Texts[0] || null;
  return {
    h1Count: h1Texts.length,
    h1Texts,
    firstH1,
    h1Missing: h1Nodes.length === 0,
    h1Empty: h1Nodes.length > 0 && h1Texts.length === 0,
    h1Multiple: h1Nodes.length > 1,
    h1Hash: hashText(firstH1),
    h1Pattern: patternForText(firstH1)
  };
}

function canonicalRobotsFacts($, finalUrl, robotsFacts) {
  const canonicalRaw = cleanText($('link[rel~="canonical"]').first().attr('href'));
  const canonical = normalizeUrl(canonicalRaw, finalUrl) || canonicalRaw;
  const finalOrigin = originOf(finalUrl);
  const canonicalOrigin = originOf(canonical);
  const canonicalMissing = !canonical;
  const canonicalSelfReferencing = Boolean(canonical && normalizeUrl(canonical) === normalizeUrl(finalUrl));
  const canonicalExternal = Boolean(canonicalOrigin && finalOrigin && canonicalOrigin !== finalOrigin);
  const robotsConflict = Boolean(
    canonicalSelfReferencing && (robotsFacts.metaNoindex || robotsFacts.xRobotsNoindex)
  );
  return {
    canonical: canonical || null,
    canonicalMissing,
    canonicalSelfReferencing,
    canonicalExternal,
    metaRobots: robotsFacts.metaRobots,
    metaNoindex: robotsFacts.metaNoindex,
    metaNofollow: robotsFacts.metaNofollow,
    xRobotsTag: robotsFacts.xRobotsTag,
    xRobotsNoindex: robotsFacts.xRobotsNoindex,
    xRobotsNofollow: robotsFacts.xRobotsNofollow,
    indexability: (robotsFacts.metaNoindex || robotsFacts.xRobotsNoindex) ? 'blocked_by_robots' : null,
    robotsConflict
  };
}

function indexabilityFor({ statusCode, contentType, metaNoindex, xRobotsNoindex }) {
  if (statusCode && statusCode >= 400) return 'http_error';
  if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) return 'non_html';
  if (metaNoindex || xRobotsNoindex) return 'blocked_by_robots';
  return 'indexable';
}

function hasDirective(value, directive) {
  return String(value || '').toLowerCase().split(/[,\s]+/).includes(directive);
}

function cleanText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function capText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function hashText(value) {
  const text = String(value || '').trim();
  return text ? crypto.createHash('sha1').update(text).digest('hex').slice(0, 16) : null;
}

function patternForText(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text
    .toLowerCase()
    .replace(/\d+/g, '{num}')
    .replace(/[a-f0-9]{8,}/g, '{hash}')
    .replace(/[^\p{L}\p{N}{}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function originOf(value) {
  try {
    return value ? new URL(value).origin : null;
  } catch {
    return null;
  }
}
