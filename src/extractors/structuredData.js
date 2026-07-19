import crypto from 'node:crypto';

export const STRUCTURED_DATA_EXTRACTION_VERSION = 'structured-data-provenance-v1';
export const SCHEMA_TYPE_HIERARCHY_VERSION = 'schema-type-hierarchy-v1';

const TYPE_PARENTS = Object.freeze({
  Article: ['CreativeWork'],
  BlogPosting: ['SocialMediaPosting', 'Article'],
  LiveBlogPosting: ['BlogPosting', 'Article'],
  NewsArticle: ['Article'],
  TechArticle: ['Article'],
  ScholarlyArticle: ['Article'],
  Report: ['Article'],
  Review: ['CreativeWork'],
  SocialMediaPosting: ['Article'],
  Product: ['Thing'],
  ProductGroup: ['Product'],
  IndividualProduct: ['Product'],
  ProductModel: ['Product'],
  SomeProducts: ['Product'],
  Organization: ['Thing'],
  Corporation: ['Organization'],
  LocalBusiness: ['Organization', 'Place'],
  Person: ['Thing'],
  BreadcrumbList: ['ItemList'],
  WebSite: ['CreativeWork'],
  WebPage: ['CreativeWork'],
  CollectionPage: ['WebPage'],
  ProfilePage: ['WebPage'],
  FAQPage: ['WebPage']
});

export const SCHEMA_TYPE_HIERARCHY = Object.freeze(
  Object.entries(TYPE_PARENTS).map(([schema_type, parent_types]) => Object.freeze({
    schema_type,
    parent_types: Object.freeze([...parent_types]),
    valid_for_families: Object.freeze([
      ...(schemaTypeIsAInternal(schema_type, 'Article') ? ['Article'] : []),
      ...(schemaTypeIsAInternal(schema_type, 'Product') ? ['Product'] : []),
      ...(schemaTypeIsAInternal(schema_type, 'Organization') ? ['Organization'] : []),
      ...(schemaTypeIsAInternal(schema_type, 'WebPage') ? ['WebPage'] : [])
    ]),
    known_limits: Object.freeze(schema_type === 'ProductGroup'
      ? ['ProductGroup establishes Product-family presence but does not prove single-product rich-result eligibility.']
      : schema_type === 'IndividualProduct'
        ? ['IndividualProduct establishes Product-family presence; offer/property completeness is evaluated separately.']
        : [])
  }))
);

export function normalizeSchemaType(type) {
  const value = String(type || '').trim();
  if (!value) return null;
  const match = value.match(/^(?:https?:\/\/schema\.org\/|schema:)([^/#?]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : value;
}

export function schemaTypeIsA(type, expectedType) {
  const normalized = normalizeSchemaType(type);
  const expected = normalizeSchemaType(expectedType);
  if (!normalized || !expected) return false;
  return schemaTypeIsAInternal(normalized, expected);
}

export function isArticleSchemaType(type) {
  return schemaTypeIsA(type, 'Article');
}

export function isProductSchemaType(type) {
  return schemaTypeIsA(type, 'Product');
}

export function hasSchemaFamily(schemaTypes = [], family) {
  return schemaTypes.some((type) => schemaTypeIsA(type, family));
}

export function analyzeStructuredDataBlocks(blocks = [], options = {}) {
  const source = options.source || 'raw';
  const rows = [];
  const blockBodies = [];
  const types = new Set();
  let parsedBlocks = 0;
  let failedBlocks = 0;
  let emptyBlocks = 0;

  for (const [blockIndex, input] of blocks.entries()) {
    const scriptType = String(
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input.scriptType ?? '')
        : 'application/ld+json'
    ).trim().toLowerCase();
    const body = String(input?.body ?? input ?? '');
    if (scriptType !== 'application/ld+json') continue;
    const trimmed = body.trim();
    const bodyLength = Buffer.byteLength(body, 'utf8');
    const snippetHash = hash(trimmed);
    if (!trimmed) {
      emptyBlocks += 1;
      rows.push(baseRow({ blockIndex, source, scriptType, bodyLength, snippetHash, parseStatus: 'empty' }));
      continue;
    }
    blockBodies.push(trimmed);
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
      parsedBlocks += 1;
    } catch (error) {
      failedBlocks += 1;
      rows.push(baseRow({
        blockIndex,
        source,
        scriptType,
        bodyLength,
        snippetHash,
        rawJson: trimmed,
        parseStatus: 'error',
        parseError: String(error.message || 'Invalid JSON').slice(0, 2000),
        parseErrorType: 'json_syntax_error',
        parseErrorPosition: parseErrorPosition(error)
      }));
      continue;
    }

    const entities = collectSchemaEntities(parsed);
    const entityIds = new Set(entities.map((entry) => normalizeEntityId(entry.value?.['@id'])).filter(Boolean));
    if (!entities.length) {
      rows.push(baseRow({ blockIndex, source, scriptType, bodyLength, snippetHash, rawJson: trimmed, parseStatus: 'ok' }));
      continue;
    }
    for (const [entityIndex, entity] of entities.entries()) {
      const schemaTypes = normalizeTypeValues(entity.value?.['@type']);
      const referencedEntityIds = collectReferencedEntityIds(entity.value);
      const properties = Object.keys(entity.value || {}).filter((key) => !key.startsWith('@')).sort();
      for (const schemaType of schemaTypes) {
        types.add(schemaType);
        rows.push(baseRow({
          blockIndex,
          entityIndex,
          entityPath: entity.path,
          entityId: normalizeEntityId(entity.value?.['@id']),
          source,
          scriptType,
          bodyLength,
          snippetHash,
          rawJson: trimmed,
          schemaType,
          parseStatus: 'ok',
          propertiesJson: JSON.stringify(properties),
          referencedEntityIdsJson: JSON.stringify(referencedEntityIds),
          entityLinked: referencedEntityIds.some((id) => entityIds.has(id)) ? 1 : 0
        }));
      }
    }
  }

  return {
    version: STRUCTURED_DATA_EXTRACTION_VERSION,
    source,
    blocksFound: parsedBlocks + failedBlocks + emptyBlocks,
    parsedBlocks,
    failedBlocks,
    emptyBlocks,
    entityRows: rows.filter((row) => row.schemaType).length,
    types: [...types].sort(),
    blockBodies,
    rows
  };
}

export function collectSchemaEntities(value) {
  const output = [];
  const seen = new Set();
  const visit = (node, path = '$') => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (normalizeTypeValues(node['@type']).length) output.push({ value: node, path });
    for (const [key, nested] of Object.entries(node)) {
      if (key === '@type') continue;
      if (nested && typeof nested === 'object') visit(nested, `${path}.${key}`);
    }
  };
  visit(value);
  return output;
}

export function collectSchemaTypes(value) {
  return [...new Set(collectSchemaEntities(value).flatMap((entry) => normalizeTypeValues(entry.value?.['@type'])))].sort();
}

function schemaTypeIsAInternal(type, expected, visited = new Set()) {
  if (type === expected) return true;
  if (visited.has(type)) return false;
  visited.add(type);
  return (TYPE_PARENTS[type] || []).some((parent) => schemaTypeIsAInternal(parent, expected, visited));
}

function normalizeTypeValues(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map(normalizeSchemaType).filter(Boolean))];
}

function collectReferencedEntityIds(value) {
  const ids = new Set();
  const visit = (node, root = false) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((item) => visit(item));
    if (!root && node['@id']) ids.add(normalizeEntityId(node['@id']));
    for (const nested of Object.values(node)) if (nested && typeof nested === 'object') visit(nested);
  };
  visit(value, true);
  return [...ids].filter(Boolean).sort();
}

function normalizeEntityId(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function baseRow(values) {
  const row = {
    schemaType: null,
    rawJson: null,
    parseStatus: 'ok',
    parseError: null,
    blockIndex: null,
    entityIndex: null,
    entityPath: null,
    entityId: null,
    source: 'raw',
    scriptType: 'application/ld+json',
    bodyLength: 0,
    snippetHash: null,
    parseErrorType: null,
    parseErrorPosition: null,
    technicalError: null,
    propertiesJson: JSON.stringify([]),
    referencedEntityIdsJson: JSON.stringify([]),
    entityLinked: 0,
    extractionStatesJson: JSON.stringify([]),
    entityCompletenessStatus: 'not_evaluated',
    extractionVersion: STRUCTURED_DATA_EXTRACTION_VERSION,
    ...values
  };
  const states = ['json_ld_block_found'];
  if (row.parseStatus === 'error') states.push('json_ld_parse_failed');
  if (row.parseStatus === 'ok') states.push('json_ld_parsed');
  if (row.schemaType) states.push('schema_entity_extracted');
  if (row.entityLinked) states.push('schema_entity_linked');
  row.extractionStatesJson = JSON.stringify(states);
  return row;
}

function parseErrorPosition(error) {
  const match = String(error?.message || '').match(/position\s+(\d+)/i);
  return match ? Number(match[1]) : null;
}

function hash(value) {
  return value ? crypto.createHash('sha256').update(value).digest('hex') : null;
}
