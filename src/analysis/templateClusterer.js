export function buildTemplateClusters(db, runId, {
  sampleUrlsPerTemplate = 5,
  maxTemplateSamplesTotal = 200
} = {}) {
  const pages = db.prepare(`
    SELECT id, url, finalUrl, statusCode, indexable, pageType, title, h1Json,
      wordCountRaw, internalLinksCount, externalLinksCount, schemaTypesJson
    FROM pages
    WHERE runId = ?
    ORDER BY url ASC
  `).all(runId).map((page) => ({
    ...page,
    schemaTypes: safeJson(page.schemaTypesJson, []),
    h1: safeJson(page.h1Json, [])
  }));

  const issueCounts = issueCountsByUrl(db, runId);
  const groups = new Map();
  for (const page of pages) {
    const urlPattern = urlPatternForPage(page);
    const clusterKey = `${page.pageType || 'other'}:${urlPattern}`;
    if (!groups.has(clusterKey)) {
      groups.set(clusterKey, {
        clusterKey,
        pageType: page.pageType || 'other',
        urlPattern,
        pages: []
      });
    }
    groups.get(clusterKey).pages.push(page);
  }

  const clusterRows = [];
  let totalSamples = 0;
  for (const group of [...groups.values()].sort((a, b) => b.pages.length - a.pages.length || a.clusterKey.localeCompare(b.clusterKey))) {
    const remainingSampleBudget = Math.max(0, maxTemplateSamplesTotal - totalSamples);
    const sampleLimit = Math.min(sampleUrlsPerTemplate, remainingSampleBudget);
    const samples = representativeSamples(group.pages, issueCounts, sampleLimit);
    totalSamples += samples.length;
    clusterRows.push({
      runId,
      clusterKey: group.clusterKey,
      pageType: group.pageType,
      urlPattern: group.urlPattern,
      urlCount: group.pages.length,
      indexableCount: group.pages.filter((page) => page.indexable).length,
      nonIndexableCount: group.pages.filter((page) => !page.indexable).length,
      statusCodeSummaryJson: JSON.stringify(countBy(group.pages, (page) => String(page.statusCode || 0))),
      schemaTypesSummaryJson: JSON.stringify(schemaSummary(group.pages)),
      avgWordCount: average(group.pages.map((page) => page.wordCountRaw)),
      avgInternalLinks: average(group.pages.map((page) => page.internalLinksCount)),
      avgExternalLinks: average(group.pages.map((page) => page.externalLinksCount)),
      sampleUrlsJson: JSON.stringify(samples)
    });
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM template_clusters WHERE runId = ?').run(runId);
    db.prepare('UPDATE pages SET templateClusterId = NULL, templateClusterKey = NULL WHERE runId = ?').run(runId);

    const insert = db.prepare(`
      INSERT INTO template_clusters (
        runId, clusterKey, pageType, urlPattern, urlCount, indexableCount,
        nonIndexableCount, statusCodeSummaryJson, schemaTypesSummaryJson,
        avgWordCount, avgInternalLinks, avgExternalLinks, sampleUrlsJson
      )
      VALUES (
        @runId, @clusterKey, @pageType, @urlPattern, @urlCount, @indexableCount,
        @nonIndexableCount, @statusCodeSummaryJson, @schemaTypesSummaryJson,
        @avgWordCount, @avgInternalLinks, @avgExternalLinks, @sampleUrlsJson
      )
    `);
    const updatePage = db.prepare(`
      UPDATE pages
      SET templateClusterId = ?, templateClusterKey = ?
      WHERE runId = ? AND id = ?
    `);

    for (const row of clusterRows) {
      const result = insert.run(row);
      const clusterId = result.lastInsertRowid;
      const group = groups.get(row.clusterKey);
      for (const page of group.pages) {
        updatePage.run(clusterId, row.clusterKey, runId, page.id);
      }
    }
  });
  tx();

  return {
    clusters: clusterRows.length,
    pages: pages.length,
    samples: totalSamples
  };
}

export function urlPatternForPage(page) {
  let pathname = '/';
  try {
    pathname = new URL(page.finalUrl || page.url).pathname || '/';
  } catch {
    pathname = '/';
  }

  const parts = pathname.split('/').filter(Boolean).map((part) => decodeURIComponentSafe(part));
  if (!parts.length) return '/';

  const pageType = page.pageType || 'other';
  const schemaTypes = new Set(page.schemaTypes || safeJson(page.schemaTypesJson, []));
  const dynamicType = dynamicTokenForPageType(pageType, schemaTypes);
  const output = parts.map((part, index) => {
    const lower = part.toLowerCase();
    const isLast = index === parts.length - 1;
    if (isNumericId(lower) || isOpaqueId(lower)) return '{id}';
    if (isLocale(lower)) return lower;
    if (isStaticRoot(lower, index)) return lower;
    if (isLast) return dynamicType;
    if (parts.length >= 3 && index === parts.length - 2) return '{subcategory}';
    return '{category}';
  });

  return `/${output.join('/')}`;
}

function representativeSamples(pages, issueCounts, limit) {
  if (!limit) return [];
  const selected = [];
  const add = (page) => {
    if (!page || selected.includes(page.url)) return;
    selected.push(page.url);
  };
  const sorted = [...pages].sort((a, b) => a.url.localeCompare(b.url));
  add(sorted.find((page) => Number(page.statusCode) === 200 && page.indexable));
  add([...sorted].sort((a, b) => Number(a.wordCountRaw || 0) - Number(b.wordCountRaw || 0) || a.url.localeCompare(b.url))[0]);
  add([...sorted].sort((a, b) => (issueCounts.get(b.url) || 0) - (issueCounts.get(a.url) || 0) || a.url.localeCompare(b.url))[0]);
  add(sorted.find((page) => (page.schemaTypes || []).length > 0));
  add(sorted.find((page) => !(page.schemaTypes || []).length));
  for (const page of sorted) add(page);
  return selected.slice(0, limit);
}

function issueCountsByUrl(db, runId) {
  const counts = new Map();
  const rows = db.prepare(`
    SELECT sampleUrlsJson
    FROM check_results
    WHERE runId = ? AND status IN ('Warning', 'Error')
  `).all(runId);
  for (const row of rows) {
    for (const url of safeJson(row.sampleUrlsJson, [])) {
      counts.set(url, (counts.get(url) || 0) + 1);
    }
  }
  return counts;
}

function dynamicTokenForPageType(pageType, schemaTypes) {
  if (pageType === 'location') return '{city}';
  if (pageType === 'category') return '{category}';
  if (pageType === 'product' || schemaTypes.has('Product')) return '{slug}';
  if (pageType === 'article' || schemaTypes.has('Article') || schemaTypes.has('BlogPosting')) return '{slug}';
  return '{slug}';
}

function isStaticRoot(value, index) {
  if (index !== 0) return false;
  return new Set([
    'blog', 'magazin', 'ratgeber', 'wissen', 'news', 'shop', 'c', 'p', 'store', 'stores', 'produkt',
    'produkte', 'product', 'products', 'category', 'kategorie', 'standorte',
    'locations', 'p', 'de', 'en'
  ]).has(value);
}

function isNumericId(value) {
  return /^\d+$/.test(value);
}

function isOpaqueId(value) {
  return /^[a-f0-9]{8,}$/i.test(value) || /^[a-z0-9]{10,}$/i.test(value) && /\d/.test(value);
}

function isLocale(value) {
  return /^[a-z]{2}(-[a-z]{2})?$/i.test(value);
}

function schemaSummary(pages) {
  const counts = {};
  for (const page of pages) {
    for (const schemaType of page.schemaTypes || []) {
      counts[schemaType] = (counts[schemaType] || 0) + 1;
    }
  }
  return sortObject(counts);
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return sortObject(counts);
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function average(values) {
  const numeric = values.map(Number).filter((value) => Number.isFinite(value));
  if (!numeric.length) return null;
  return Number((numeric.reduce((sum, value) => sum + value, 0) / numeric.length).toFixed(2));
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}
