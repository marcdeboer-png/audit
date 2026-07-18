export const PAGE_TYPES = Object.freeze([
  'homepage',
  'blog_index',
  'article_index',
  'category_index',
  'product_index',
  'article',
  'product',
  'category',
  'location',
  'legal',
  'contact',
  'other'
]);

export function detectPageType({ url, schemaTypes = [], title = '', h1 = [], h2 = [], bodyText = '', rawHtml = '', semanticSignals = {} }) {
  const parsed = safeUrl(url);
  const path = parsed ? normalizeText(parsed.pathname) : '';
  const segments = path.split('/').filter(Boolean);
  const text = normalizeText([title, ...h1, ...h2, path].join(' '));
  const body = normalizeText(bodyText);
  const html = String(rawHtml || '');
  const schemas = schemaTypes.map((type) => String(type).toLowerCase());

  if (!segments.length || ['index', 'index.html', 'home', 'startseite'].includes(segments.at(-1))) {
    return 'homepage';
  }

  if (segments[0] === 'c') return segments.length === 1 ? 'category_index' : 'category';
  if (['category', 'categories', 'kategorie', 'kategorien', 'themen', 'topics', 'collection', 'collections'].includes(segments[0])) {
    return segments.length === 1 ? 'category_index' : 'category';
  }
  if (segments[0] === 'p' && segments.length >= 2) return 'product';
  if (['store', 'stores', 'filiale', 'filialen'].includes(segments[0]) && segments.length >= 2) return 'location';

  if (isLegalPage({ segments, text, title, h1 })) {
    return 'legal';
  }

  if (matches(text, /\b(kontakt|contact|support|anfrage|inquiry)\b/)) {
    return 'contact';
  }

  if (isIndexPath(segments, ['blog'])) return 'blog_index';
  if (isIndexPath(segments, ['magazin', 'ratgeber', 'news', 'artikel', 'article', 'articles', 'insights', 'wissen'])) return 'article_index';
  if (isIndexPath(segments, ['category', 'categories', 'kategorie', 'kategorien', 'themen', 'topics', 'collection', 'collections'])) return 'category_index';
  if (isIndexPath(segments, ['shop', 'produkt', 'produkte', 'product', 'products'])) return 'product_index';
  if (isArchiveOrListingPath(segments, path)) {
    if (segments.some((segment) => ['blog'].includes(segment))) return 'blog_index';
    if (segments.some((segment) => ['category', 'categories', 'kategorie', 'tag', 'tags', 'themen', 'topics'].includes(segment))) return 'category_index';
    return 'article_index';
  }

  if (isStrongProductPage({ schemas, segments, path, text, body, html })) {
    return 'product';
  }

  if (isArticleDetail({ schemas, segments, path, text, html, semanticSignals })) {
    return 'article';
  }

  if (hasAnySchema(schemas, ['localbusiness', 'place']) || matches(text, /\b(standort|filiale|store|stores|location|near me|adresse|oeffnungszeiten|opening hours)\b/) || matches(path, /\/(standort|standorte|store|stores|filiale|filialen|location|locations|city|cities)\//)) {
    return 'location';
  }

  if (matches(text, /\b(category|kategorie|collection|collections|shop|produkte|leistungen|services|themen|topics)\b/) || matches(path, /\/(c|category|categories|kategorie|shop|collections|themen|topics)\//)) {
    return 'category';
  }

  return 'other';
}

export function isStrongProductPage({ schemas = [], segments = [], path = '', text = '', body = '', html = '' }) {
  if (hasAnySchema(schemas, ['product'])) return true;
  const pathHasProductPattern = matches(path, /\/(product|products|produkt|produkte|shop|p)\//);
  const hasSlugAfterProductRoot = pathHasProductPattern && segments.length >= 2 && !isIndexOnlySegment(segments.at(-1));
  const productSignals = [
    /\b(sku|gtin|mpn|artikelnummer|product id)\b/.test(`${text} ${body}`),
    /\b(in den warenkorb|add to cart|buy now|checkout|warenkorb)\b/.test(`${text} ${body}`),
    /€|\$|£|\b(price|preis|angebot|offer)\b/.test(`${text} ${body}`)
  ].filter(Boolean).length;
  return (hasSlugAfterProductRoot && productSignals >= 2) || (matches(path, /\/p\/\d+/) && productSignals >= 1);
}

function isArticleDetail({ schemas = [], segments = [], path = '', text = '', html = '', semanticSignals = {} }) {
  if (hasAnySchema(schemas, ['article', 'blogposting', 'newsarticle', 'report']) && !isArchiveOrListingPath(segments, path)) return true;
  const roots = ['blog', 'news', 'article', 'articles', 'artikel', 'ratgeber', 'magazin', 'insights', 'wissen'];
  const hasArticleRoot = segments.some((segment) => roots.includes(segment));
  if (!hasArticleRoot || segments.length < 2) return false;
  if (isArchiveOrListingPath(segments, path)) return false;
  if (matches(path, /\/(tag|tags|category|categories|kategorie|author|autor|archive|page)\/?($|\/)/)) return false;
  const explicitDetailRoot = matches(path, /\/(beitrag|post|posts|article|articles|artikel)\//);
  const articleElementCount = Number(semanticSignals.articleElementCount || (html.match(/<article\b/gi) || []).length);
  return explicitDetailRoot || articleElementCount > 0;
}

function isIndexPath(segments, roots) {
  if (segments.length !== 1) return false;
  return roots.includes(segments[0]);
}

function isArchiveOrListingPath(segments, path) {
  if (!segments.length) return false;
  return matches(path, /\/(tag|tags|category|categories|kategorie|author|autor|archive|archives|page|seite)(?:\/[^/]+)?\/?$/) ||
    segments.some((segment) => /^\d{4}$/.test(segment)) ||
    (segments.length <= 2 && ['tag', 'tags', 'author', 'autor'].includes(segments[0]));
}

function isLegalPage({ segments, text, title = '', h1 = [] }) {
  const exactLegalSegments = new Set([
    'impressum', 'datenschutz', 'datenschutzerklaerung', 'privacy', 'privacy-policy',
    'terms', 'terms-of-service', 'agb', 'legal', 'legal-notice', 'cookie-policy',
    'cookie-richtlinie', 'disclaimer'
  ]);
  if (segments.some((segment) => exactLegalSegments.has(segment))) return true;
  const semanticLabels = [title, ...h1].map((value) => normalizeText(value).trim());
  if (semanticLabels.some((value) => /^(impressum|datenschutz(?:erklaerung)?|privacy policy|terms(?: of service)?|agb|legal notice|cookie policy|cookie richtlinie|disclaimer)$/.test(value))) return true;
  return /^(impressum|datenschutz(?:erklaerung)?|privacy policy|terms(?: of service)?|agb|legal notice|cookie policy|cookie richtlinie|disclaimer)(?:\s|$)/.test(text.trim());
}

export function isArticleSchemaType(type) {
  return ['article', 'blogposting', 'newsarticle', 'report', 'scholarlyarticle', 'socialmediaposting', 'techarticle']
    .includes(String(type || '').toLowerCase());
}

export function hasArticleSchema(schemaTypes = []) {
  return schemaTypes.some(isArticleSchemaType);
}

function isIndexOnlySegment(segment = '') {
  return ['index', 'index.html', 'home', 'startseite'].includes(segment);
}

function safeUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
}

function matches(value, pattern) {
  return pattern.test(value);
}

function hasAnySchema(schemas, wanted) {
  return wanted.some((type) => schemas.includes(type));
}
