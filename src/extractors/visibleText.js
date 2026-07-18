import crypto from 'node:crypto';
import * as cheerio from 'cheerio';

export const RAW_HIDDEN_SELECTORS = [
  'head', 'script', 'style', 'noscript', 'template', 'svg',
  '[hidden]', '[aria-hidden="true"]', 'input[type="hidden"]',
  'dialog:not([open])',
  '[style*="display:none" i]', '[style*="display: none" i]',
  '[style*="visibility:hidden" i]', '[style*="visibility: hidden" i]',
  '[style*="content-visibility:hidden" i]', '[style*="content-visibility: hidden" i]'
];

export const VISIBLE_TEXT_NORMALIZATION_VERSION = 'visible_text_v1';

export function extractTextKinds(rawHtml = '') {
  const $ = cheerio.load(rawHtml || '');
  const rawText = normalizeVisibleText(joinedTextNodes($, $('body')));
  const structuredDataText = normalizeVisibleText($('script[type="application/ld+json"]').map((_, el) => joinedTextNodes($, $(el))).get().join(' '));
  const metadataText = normalizeVisibleText([
    $('title').first().text(),
    $('meta[name="description"]').first().attr('content') || '',
    $('meta[property^="og:"]').map((_, el) => $(el).attr('content') || '').get().join(' ')
  ].join(' '));
  const visibleRoot = $.root().clone();
  visibleRoot.find(RAW_HIDDEN_SELECTORS.join(',')).remove();
  visibleRoot.find('details:not([open])').each((_, details) => {
    $(details).contents().each((__, child) => {
      if (child.type === 'tag' && String(child.name || '').toLowerCase() === 'summary') return;
      $(child).remove();
    });
  });
  const visibleText = normalizeVisibleText(joinedTextNodes($, visibleRoot.find('body')));
  return {
    rawText,
    visibleText,
    structuredDataText,
    metadataText,
    rawTextLength: rawText.length,
    visibleTextLength: visibleText.length,
    structuredDataTextLength: structuredDataText.length,
    metadataTextLength: metadataText.length,
    rawTextHash: textHash(rawText),
    visibleTextHash: textHash(visibleText),
    structuredDataTextHash: textHash(structuredDataText),
    metadataTextHash: textHash(metadataText)
  };
}

function joinedTextNodes($, root) {
  return root
    .find('*')
    .addBack()
    .contents()
    .filter((_, node) => node.type === 'text')
    .map((_, node) => $(node).text())
    .get()
    .join(' ');
}

export function normalizeVisibleText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function textHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

export function countVisibleWords(text) {
  const matches = String(text || '').trim().match(/\b[\p{L}\p{N}'-]+\b/gu);
  return matches ? matches.length : 0;
}

export function hasVisibleTextProvenance(value) {
  try {
    const facts = typeof value === 'string' ? JSON.parse(value) : value;
    const length = facts?.visible_text?.length;
    return Boolean(
      facts?.normalization_version === VISIBLE_TEXT_NORMALIZATION_VERSION &&
      length !== null && length !== undefined && Number.isFinite(Number(length))
    );
  } catch {
    return false;
  }
}

// This function is serialized into the browser context. Keep it dependency-free.
export function browserVisibleTextEvaluator() {
  const excludedTags = new Set(['HEAD', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);
  const output = [];
  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      output.push(node.nodeValue || '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (excludedTags.has(node.tagName) || node.hidden || node.getAttribute('aria-hidden') === 'true') return;
      if (node.tagName === 'DIALOG' && !node.hasAttribute('open')) return;
      const closedDetails = node.closest('details:not([open])');
      if (closedDetails && node.tagName !== 'SUMMARY' && !node.closest('summary')) return;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.contentVisibility === 'hidden') return;
      if (typeof node.checkVisibility === 'function' && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return;
    }
    for (const child of node.childNodes || []) visit(child);
    if (node.shadowRoot) visit(node.shadowRoot);
  };
  visit(document.body);
  return output.join(' ').replace(/\s+/g, ' ').trim();
}
