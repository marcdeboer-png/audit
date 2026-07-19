import {
  hasSchemaFamily,
  isArticleSchemaType,
  isProductSchemaType
} from './structuredData.js';

export const PAGE_TYPE_CLASSIFICATION_VERSION = 'structured-page-type-v2';

export const PAGE_TYPES = Object.freeze([
  'homepage', 'blog_index', 'article_index', 'category_index', 'product_index',
  'article', 'product', 'category', 'location', 'legal', 'contact', 'other'
]);

export function detectPageType(input) {
  return classifyPageType(input).pageType;
}

export function classifyPageType({ url, schemaTypes = [], title = '', h1 = [], h2 = [], bodyText = '', rawHtml = '', semanticSignals = {} }) {
  const parsed = safeUrl(url);
  const path = parsed ? normalizeText(parsed.pathname) : '';
  const segments = path.split('/').filter(Boolean);
  const text = normalizeText([title, ...h1, ...h2, path].join(' '));
  const body = normalizeText(bodyText);
  const html = String(rawHtml || '');
  const schemas = schemaTypes.map((type) => String(type || '').trim()).filter(Boolean);
  const signals = [];
  const decide = (pageType, confidence, reason) => ({
    pageType,
    confidence,
    signals: [...signals, reason].filter(Boolean),
    version: PAGE_TYPE_CLASSIFICATION_VERSION
  });

  if (!segments.length || ['index', 'index.html', 'home', 'startseite'].includes(segments.at(-1))) {
    return decide('homepage', 'high', 'root_or_home_path');
  }
  if (isLegalPage({ segments, text, title, h1 })) return decide('legal', 'high', 'explicit_legal_path_or_heading');
  if (matches(text, /\b(kontakt|contact|support|anfrage|inquiry)\b/)) return decide('contact', 'high', 'explicit_contact_path_or_heading');

  const listing = listingClassification(segments, path);
  if (listing) return decide(listing, 'high', 'explicit_listing_or_archive_path');

  const product = classifyProductDetail({ schemas, segments, path, text, body, html, semanticSignals });
  if (product.matched) return decide('product', product.confidence, product.reason);

  const article = classifyArticleDetail({ schemas, segments, path, text, body, html, semanticSignals });
  if (article.matched) return decide('article', article.confidence, article.reason);

  if (hasSchemaFamily(schemas, 'LocalBusiness') || matches(text, /\b(standort|filiale|store|stores|location|near me|adresse|oeffnungszeiten|opening hours)\b/) || matches(path, /\/(standort|standorte|store|stores|filiale|filialen|location|locations|city|cities)\//)) {
    return decide('location', hasSchemaFamily(schemas, 'LocalBusiness') ? 'high' : 'medium', 'local_business_or_location_signals');
  }
  if (matches(text, /\b(category|kategorie|collection|collections|shop|produkte|leistungen|services|themen|topics)\b/) || matches(path, /\/(c|category|categories|kategorie|shop|collections|themen|topics)\//)) {
    return decide('category', 'medium', 'category_or_hub_signals');
  }
  return decide('other', 'low', 'no_reliable_detail_page_type_signal');
}

export function isStrongProductPage(input) {
  return classifyProductDetail(input).matched;
}

function classifyProductDetail({ schemas = [], segments = [], path = '', text = '', body = '', html = '', semanticSignals = {} }) {
  if (isArchiveOrListingPath(segments, path) || isProductListingPath(segments, path)) {
    return { matched: false, confidence: 'high', reason: 'listing_path_excludes_product_detail' };
  }
  const hasProductSchema = schemas.some(isProductSchemaType);
  const hasOfferSchema = schemas.some((type) => ['Offer', 'AggregateOffer'].includes(String(type)));
  const explicitProductPath = matches(path, /\/(product|products|produkt|produkte|shop|p)\//) && segments.length >= 2 && !isIndexOnlySegment(segments.at(-1));
  const dedicatedProductRoute = matches(path, /\/(?:p|product|produkt)\/[^/]+\/?$/);
  const productSignals = [
    /\b(sku|gtin|mpn|artikelnummer|product id)\b/.test(`${text} ${body}`),
    /\b(in den warenkorb|add to cart|buy now|checkout|warenkorb|add to bag)\b/.test(`${text} ${body}`),
    /€|\$|£|\b(price|preis|angebot|offer|availability|in stock|out of stock)\b/.test(`${text} ${body}`),
    Number(semanticSignals.productDetailFormCount || 0) > 0
  ].filter(Boolean).length;

  if (dedicatedProductRoute && (hasProductSchema || hasOfferSchema || productSignals >= 1)) {
    return { matched: true, confidence: 'high', reason: 'dedicated_product_route_with_independent_product_evidence' };
  }
  if (explicitProductPath && hasProductSchema && (segments.length >= 3 || hasOfferSchema || productSignals >= 1)) {
    return { matched: true, confidence: 'high', reason: 'product_path_schema_and_commerce_evidence' };
  }
  if (hasProductSchema && hasOfferSchema && productSignals >= 1) {
    return { matched: true, confidence: 'high', reason: 'product_offer_and_visible_commerce_evidence' };
  }
  if (explicitProductPath && productSignals >= 2) {
    return { matched: true, confidence: 'high', reason: 'product_path_and_multiple_visible_commerce_signals' };
  }
  if (segments[0] === 'p' && segments.length >= 2) {
    return { matched: true, confidence: 'medium', reason: 'dedicated_product_route_without_confirming_page_facts' };
  }
  return { matched: false, confidence: 'low', reason: 'insufficient_independent_product_detail_signals' };
}

function classifyArticleDetail({ schemas = [], segments = [], path = '', body = '', html = '', semanticSignals = {} }) {
  if (isArchiveOrListingPath(segments, path)) return { matched: false, confidence: 'high', reason: 'archive_path_excludes_article_detail' };
  const articleSchema = schemas.some(isArticleSchemaType);
  const roots = ['blog', 'news', 'article', 'articles', 'artikel', 'ratgeber', 'magazin', 'insights', 'wissen'];
  const hasArticleRoot = segments.some((segment) => roots.includes(segment));
  const explicitDetailRoot = matches(path, /\/(beitrag|post|posts|article|articles|artikel)\//);
  const articleElementCount = Number(semanticSignals.articleElementCount || (html.match(/<article\b/gi) || []).length);
  const visibleEditorialSignals = [
    articleElementCount > 0,
    Number(semanticSignals.visibleBylineCount || 0) > 0,
    Number(semanticSignals.visibleDateCount || 0) > 0,
    /\b(by|von|published|veroeffentlicht|autor|author)\b/.test(body)
  ].filter(Boolean).length;
  if (articleSchema && (hasArticleRoot || explicitDetailRoot || articleElementCount > 0)) {
    return { matched: true, confidence: 'high', reason: 'article_schema_and_detail_context' };
  }
  if ((hasArticleRoot || explicitDetailRoot) && segments.length >= 2 && visibleEditorialSignals >= 1) {
    return { matched: true, confidence: 'high', reason: 'article_route_and_visible_editorial_structure' };
  }
  if (articleSchema) return { matched: true, confidence: 'medium', reason: 'article_schema_without_confirmed_detail_context' };
  return { matched: false, confidence: 'low', reason: 'insufficient_independent_article_detail_signals' };
}

function listingClassification(segments, path) {
  if (segments[0] === 'c') return segments.length === 1 ? 'category_index' : 'category';
  if (['category', 'categories', 'kategorie', 'kategorien', 'themen', 'topics', 'collection', 'collections', 'themes'].includes(segments[0])) {
    return segments.length === 1 ? 'category_index' : 'category';
  }
  if (isIndexPath(segments, ['blog'])) return 'blog_index';
  if (segments.length === 2 && segments[0] === 'blog' && ['news', 'offers', 'angebote', 'recipes', 'rezepte', 'topics', 'themen', 'categories', 'kategorien'].includes(segments[1])) return 'blog_index';
  if (isIndexPath(segments, ['magazin', 'ratgeber', 'news', 'artikel', 'article', 'articles', 'insights', 'wissen'])) return 'article_index';
  if (isIndexPath(segments, ['shop', 'produkt', 'produkte', 'product', 'products'])) return 'product_index';
  if (isArchiveOrListingPath(segments, path)) {
    if (segments.some((segment) => segment === 'blog')) return 'blog_index';
    if (segments.some((segment) => ['category', 'categories', 'kategorie', 'tag', 'tags', 'themen', 'topics'].includes(segment))) return 'category_index';
    return 'article_index';
  }
  return null;
}

function isProductListingPath(segments, path) {
  const listingSegments = new Set(['c', 'category', 'categories', 'kategorie', 'kategorien', 'collection', 'collections', 'themes', 'search', 'suche', 'filter']);
  return segments.some((segment) => listingSegments.has(segment)) || /[?&](?:q|query|search|filter|sort)=/i.test(path);
}

function isIndexPath(segments, roots) {
  return segments.length === 1 && roots.includes(segments[0]);
}

function isArchiveOrListingPath(segments, path) {
  if (!segments.length) return false;
  return matches(path, /\/(tag|tags|category|categories|kategorie|author|autor|archive|archives|page|seite)(?:\/[^/]+)?\/?$/) ||
    segments.some((segment) => /^\d{4}$/.test(segment)) ||
    (segments.length <= 2 && ['tag', 'tags', 'author', 'autor'].includes(segments[0]));
}

function isLegalPage({ segments, text, title = '', h1 = [] }) {
  const exact = new Set(['impressum', 'datenschutz', 'datenschutzerklaerung', 'privacy', 'privacy-policy', 'terms', 'terms-of-service', 'agb', 'legal', 'legal-notice', 'cookie-policy', 'cookie-richtlinie', 'disclaimer']);
  if (segments.some((segment) => exact.has(segment))) return true;
  const labels = [title, ...h1].map((value) => normalizeText(value).trim());
  return labels.some((value) => /^(impressum|datenschutz(?:erklaerung)?|privacy policy|terms(?: of service)?|agb|legal notice|cookie policy|cookie richtlinie|disclaimer)$/.test(value)) ||
    /^(impressum|datenschutz(?:erklaerung)?|privacy policy|terms(?: of service)?|agb|legal notice|cookie policy|cookie richtlinie|disclaimer)(?:\s|$)/.test(text.trim());
}

export { isArticleSchemaType, isProductSchemaType };

export function hasArticleSchema(schemaTypes = []) {
  return schemaTypes.some(isArticleSchemaType);
}

export function hasProductSchema(schemaTypes = []) {
  return schemaTypes.some(isProductSchemaType);
}

function isIndexOnlySegment(segment = '') {
  return ['index', 'index.html', 'home', 'startseite'].includes(segment);
}

function safeUrl(url) {
  try { return new URL(url); } catch { return null; }
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
}

function matches(value, pattern) {
  return pattern.test(value);
}
