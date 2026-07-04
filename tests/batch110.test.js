import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { initDatabase } from '../src/db/database.js';
import { createProject, createRun, updateProject, updateRun } from '../src/db/repositories.js';
import { normalizeAuditConfig } from '../src/crawler/auditRunner.js';
import { buildMaturityModel } from '../src/maturity/maturityService.js';
import { extractTargetedFacts } from '../src/evidenceJobs/targetedFactExtractors.js';
import { dryRunEvidenceJob, createAndRunEvidenceJob } from '../src/evidenceJobs/evidenceJobRunner.js';
import { estimateEvidenceJobStorage, getEvidenceJobType } from '../src/evidenceJobs/evidenceJobTypes.js';
import { buildEvidenceImpactForRun } from '../src/evidenceJobs/evidenceImpactService.js';
import { insertTargetedEvidenceFact, listTargetedEvidenceFacts, listTargetedEvidenceFactsForRun } from '../src/evidenceJobs/evidenceJobRepository.js';
import { collectFullAuditZip } from '../src/results/checkExportService.js';

test('Batch 11.0 schema summary facts extract compact schema types, hashes and capped JSON-LD', () => {
  const html = `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'Product', name: 'Example product', offers: { '@type': 'Offer', price: '1.00' } },
        { '@type': 'BreadcrumbList', itemListElement: [] },
        { '@type': 'Organization', name: 'Example' },
        { '@type': 'WebSite', name: 'Example' }
      ],
      filler: 'x'.repeat(4000)
    })}</script>
    <script type="application/ld+json">{ invalid json</script>
  </head><body><main itemscope itemtype="https://schema.org/Article"><h1>Article</h1></main></body></html>`;

  const facts = extractTargetedFacts('schema_summary_facts', html, context('https://example.com/pdp'));
  assert.equal(facts.jsonLdBlockCount, 2);
  assert.ok(facts.schemaTypes.includes('Product'));
  assert.ok(facts.schemaTypes.includes('BreadcrumbList'));
  assert.ok(facts.schemaTypes.includes('Organization'));
  assert.ok(facts.schemaTypes.includes('WebSite'));
  assert.ok(facts.schemaTypes.includes('Article'));
  assert.equal(facts.hasProduct, true);
  assert.equal(facts.hasBreadcrumbList, true);
  assert.match(facts.jsonLdHashes[0], /^[a-f0-9]{16}$/);
  assert.ok(Buffer.byteLength(facts.cappedJsonLdExcerpt, 'utf8') <= 2048);
  assert.equal(facts.rawJsonCapped, true);
  assert.equal(facts.parseErrors.length, 1);
  assert.match(facts.schemaSummaryHash, /^[a-f0-9]{16}$/);
});

test('Batch 11.0 hreflang facts extract entries, x-default, invalid codes and canonical conflict without return-link claims', () => {
  const html = `<!doctype html><html><head>
    <link rel="canonical" href="https://example.com/de/canonical">
    <link rel="alternate" hreflang="de-DE" href="https://example.com/de/page">
    <link rel="alternate" hreflang="en-US" href="https://example.com/en/page">
    <link rel="alternate" hreflang="x-default" href="https://example.com/">
    <link rel="alternate" hreflang="bad_code" href="">
    <link rel="alternate" hreflang="fr-FR" href="https://example.fr/page">
  </head><body></body></html>`;

  const facts = extractTargetedFacts('hreflang_facts', html, context('https://example.com/de/page'));
  assert.equal(facts.hreflangCount, 5);
  assert.deepEqual(facts.languages, ['de', 'en', 'fr']);
  assert.ok(facts.regions.includes('DE'));
  assert.equal(facts.hasXDefault, true);
  assert.equal(facts.hasSelfLanguage, true);
  assert.equal(facts.hasInvalidLanguageCodes, true);
  assert.equal(facts.hasEmptyHref, true);
  assert.equal(facts.hasExternalHreflangTargets, true);
  assert.equal(facts.canonicalHreflangConflict, true);
  assert.equal(facts.returnLinkValidationPerformed, false);
  assert.match(facts.hreflangSummaryHash, /^[a-f0-9]{16}$/);
});

test('Batch 11.0 new targeted jobs dry-run and execute without raw HTML or full JSON-LD dumps', async () => {
  const site = await startTargetedSite();
  const db = setupDb();
  try {
    const runId = seedRun(db, site.origin, [`${site.origin}/schema`, `${site.origin}/hreflang`]);

    for (const jobType of ['schema_summary_facts', 'hreflang_facts']) {
      const definition = getEvidenceJobType(jobType);
      assert.ok(definition);
      assert.equal(definition.storesRawHtml, false);
      assert.equal(definition.storesRenderedHtml, false);
      assert.ok(['low', 'medium'].includes(estimateEvidenceJobStorage(jobType, 20).riskLevel));

      const dryRun = await dryRunEvidenceJob(db, runId, { jobType, urlSource: 'current_run_urls', maxUrls: 1 });
      assert.equal(dryRun.canRun, true);
      assert.equal(dryRun.effectiveUrlCount, 1);

      const job = await createAndRunEvidenceJob(db, runId, { jobType, urlSource: 'current_run_urls', maxUrls: 1 });
      assert.equal(job.status, 'completed');
      assert.equal(job.urlCountProcessed, 1);
      assert.equal(job.summary.rawHtmlStored, false);
      assert.equal(job.summary.renderedHtmlStored, false);
      assert.equal(job.summary.factSummary.jobType, jobType);
      const facts = listTargetedEvidenceFacts(db, job.jobId);
      assert.equal(facts.length, 1);
      assert.equal(JSON.stringify(facts).includes('<html'), false);
      if (jobType === 'schema_summary_facts') {
        assert.ok(facts[0].facts.cappedJsonLdExcerpt.length <= 2048);
        assert.equal(facts[0].facts.rawJsonCapped, true);
        assert.equal(JSON.stringify(facts[0].facts).includes('x'.repeat(2500)), false);
      }
    }

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM page_snapshots').get().count, 0);
  } finally {
    db.close();
    await site.close();
  }
});

test('Batch 11.0 schema and hreflang facts improve validation impact without fake full-domain coverage', () => {
  const db = setupDb();
  const runId = seedRun(db, 'https://example.com', ['https://example.com/a', 'https://example.com/b']);
  saveValidationReport(db, buildValidationReport(runId));
  seedFactJob(db, runId, 'schema_summary_facts', [
    targetedFact('schema_summary_facts', 'https://example.com/a', {
      schemaTypes: ['Product', 'BreadcrumbList', 'Organization'],
      schemaBlockCount: 2,
      jsonLdBlockCount: 2,
      jsonLdHashes: ['schemahash1'],
      hasProduct: true,
      hasBreadcrumbList: true,
      hasOrganization: true,
      schemaSummaryHash: 'schema-summary'
    })
  ]);
  seedFactJob(db, runId, 'hreflang_facts', [
    targetedFact('hreflang_facts', 'https://example.com/a', {
      hreflangCount: 2,
      hreflangEntries: [],
      languages: ['de', 'en'],
      regions: ['DE', 'US'],
      hasXDefault: true,
      hasSelfLanguage: true,
      returnLinkValidationPerformed: false,
      hreflangSummaryHash: 'hreflang-summary'
    })
  ]);

  const impact = buildEvidenceImpactForRun(db, runId);
  assert.equal(impact.factSummaries.schema_summary_facts.productCount, 1);
  assert.equal(impact.factSummaries.hreflang_facts.hreflangEntryCount, 2);
  const schemaItem = impact.changedItems.find((item) => item.manualItemId === 'manual-schema');
  assert.ok(schemaItem.newMatchReasons.includes('targeted_schema_types_available'));
  assert.ok(schemaItem.upgradeLimitations.includes('full_domain_schema_coverage_not_proven'));
  assert.notEqual(schemaItem.newStatus, 'covered');
  const hreflangItem = impact.changedItems.find((item) => item.manualItemId === 'manual-hreflang');
  assert.ok(hreflangItem.newMatchReasons.includes('targeted_hreflang_entries_available'));
  assert.ok(hreflangItem.upgradeLimitations.includes('return_link_validation_not_performed'));
  assert.notEqual(hreflangItem.newStatus, 'covered');
  assert.ok(impact.coverageAfter.coveragePercent >= impact.coverageBefore.coveragePercent);
  db.close();
});

test('Batch 11.0 exports and UI expose schema/hreflang jobs and maturity score uses 0-10 formatting', () => {
  const db = setupDb();
  const runId = seedRun(db, 'https://example.com', ['https://example.com/a']);
  seedMaturityCheckResults(db, runId);
  saveValidationReport(db, buildValidationReport(runId));
  const job = seedFactJob(db, runId, 'schema_summary_facts', [
    targetedFact('schema_summary_facts', 'https://example.com/a', {
      schemaTypes: ['Product'],
      schemaBlockCount: 1,
      jsonLdBlockCount: 1,
      jsonLdHashes: ['schemahash1'],
      cappedJsonLdExcerpt: '{"@type":"Product"}',
      schemaSummaryHash: 'schema-summary'
    })
  ]);

  const zipEntries = readStoredZip(collectFullAuditZip(db, runId, ['findings']).buffer);
  assert.ok(zipEntries[`evidence-jobs/job-${job.jobId}-facts.csv`]);
  assert.equal(zipEntries[`evidence-jobs/job-${job.jobId}-facts.csv`].includes('<html'), false);
  assert.equal(zipEntries[`evidence-jobs/job-${job.jobId}-facts.csv`].includes('x'.repeat(1000)), false);
  assert.ok(zipEntries['validation/evidence-job-impact.json']);

  const maturity = buildMaturityModel(db, runId);
  assert.equal(maturity.scoreScale, '0-10');
  assert.ok(maturity.maturityScore >= 0 && maturity.maturityScore <= 10);
  assert.ok(maturity.weightedScore >= 0 && maturity.weightedScore <= 10);

  const app = fs.readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  assert.match(app, /schema_summary_facts/);
  assert.match(app, /hreflang_facts/);
  assert.match(app, /formatMaturityScore/);
  assert.ok(app.includes("maturityStat('Gesamtscore', formatMaturityScore(weightedScore)"));
  assert.equal(app.includes("maturityStat('Gesamtscore', weightedScore"), false);
  db.close();
});

function setupDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initDatabase(db);
  return db;
}

function context(url) {
  return {
    url,
    finalUrl: url,
    statusCode: 200,
    contentType: 'text/html',
    headers: {}
  };
}

function seedRun(db, domain, urls) {
  const projectId = createProject(db, { inputDomain: domain, brandName: 'Example' });
  updateProject(db, projectId, { finalDomain: domain });
  const runId = createRun(db, projectId, normalizeAuditConfig({
    domain,
    auditType: 'both',
    maxUrls: Math.max(20, urls.length),
    maxDepth: 1,
    concurrency: 1,
    enableTemplateSampling: false,
    enablePlaywrightSampling: false,
    enableLighthouseSampling: false
  }));
  updateRun(db, runId, {
    status: 'completed',
    currentPhase: 'completed',
    processedUrls: urls.length,
    successfulUrls: urls.length,
    startedAt: '2026-07-05T08:00:00.000Z',
    finishedAt: '2026-07-05T08:00:02.000Z'
  });
  for (const url of urls) {
    db.prepare(`
      INSERT INTO pages (
        runId, url, normalizedUrl, finalUrl, depth, statusCode, contentType,
        indexable, title, titleLength, metaDescription, metaDescriptionLength,
        h1Json, h1Count
      )
      VALUES (?, ?, ?, ?, 0, 200, 'text/html', 1, 'Seed', 4, 'Seed description', 16, '["Seed"]', 1)
    `).run(runId, url, url, url);
  }
  return runId;
}

function saveValidationReport(db, report) {
  db.prepare(`
    INSERT INTO validation_reports (
      runId, referenceFilename, referenceFormat, sourceHash, outputDir,
      summaryJson, reportJson, benchmarkSummaryJson
    )
    VALUES (?, 'reference.json', 'json', 'batch110-hash', NULL, ?, ?, '{}')
  `).run(report.runId, JSON.stringify(report.validationSummary || {}), JSON.stringify(report));
}

function buildValidationReport(runId) {
  const coverageMatrix = [
    coverageRow('manual-schema', 'Structured Data Product BreadcrumbList Organization Schema', 'Structured Data', 'schema_summary_facts', ['evidence_too_weak', 'missing_affected_count', 'sample_too_small', 'missing_template_context']),
    coverageRow('manual-hreflang', 'Hreflang international x-default return links', 'International SEO', 'hreflang_facts', ['evidence_too_weak', 'missing_affected_count', 'sample_too_small', 'missing_data_source'])
  ];
  return {
    runId,
    generatedAt: '2026-07-05T08:10:00.000Z',
    referenceAudit: { filename: 'reference.json', format: 'json' },
    validationSummary: {
      manualItemCount: coverageMatrix.length,
      covered: 0,
      coveredInSample: 0,
      partiallyCovered: coverageMatrix.length,
      notCovered: 0,
      coveragePercent: 50,
      dataBasisLabel: 'Sample validation'
    },
    coverageMatrix,
    unmatchedToolFindings: [],
    checkRoadmap: [],
    unresolvedAuditQueue: { summary: { unresolvedCount: coverageMatrix.length }, points: [], evidenceJobPlan: { recommendedJobCount: 2, jobs: [] } },
    evidencePacks: {},
    evidenceJobPlan: { recommendedJobCount: 2, jobs: [] }
  };
}

function coverageRow(id, title, category, jobType, missingReasons) {
  return {
    manualItemId: id,
    manualItem: {
      id,
      title,
      category,
      priority: 'High',
      affectedUrls: ['https://example.com/a'],
      requiresExternalData: false,
      requiresHumanJudgment: false,
      requiresLlmJudgment: false
    },
    coverageStatus: 'partially_covered',
    confidence: 'medium',
    matchedCheckId: `check.${jobType}`,
    matchedCheckIds: [`check.${jobType}`],
    expectedCheckIds: [`expected.${jobType}`],
    matchScore: 60,
    evidenceMatchScore: 60,
    matchReasons: ['same_check_family'],
    missingReasons,
    partialReason: missingReasons[0],
    rationale: 'Needs targeted evidence.'
  };
}

function seedFactJob(db, runId, jobType, facts) {
  const result = db.prepare(`
    INSERT INTO evidence_jobs (
      runId, validationId, jobType, label, status, urlSource, urlCountPlanned,
      urlCountProcessed, urlCountSucceeded, urlCountFailed, maxUrls, dryRun,
      storageProfile, factsToExtractJson, storesRawHtml, storesRenderedHtml,
      estimatedBytesPerUrl, estimatedTotalBytes, actualStoredBytesEstimate,
      summaryJson, warningsJson, errorsJson, configJson
    )
    VALUES (?, NULL, ?, ?, 'completed', 'current_run_urls', ?, ?, ?, 0, ?, 0,
      'targeted_minimal', ?, 0, 0, 1000, ?, ?, ?, '[]', '[]', '{}')
  `).run(
    runId,
    jobType,
    jobType,
    facts.length,
    facts.length,
    facts.length,
    facts.length,
    JSON.stringify([jobType]),
    facts.length * 1000,
    facts.length * 300,
    JSON.stringify({ rawHtmlStored: false, renderedHtmlStored: false })
  );
  const jobId = result.lastInsertRowid;
  for (const fact of facts) insertTargetedEvidenceFact(db, { ...fact, runId, jobId, jobType });
  return { jobId, runId, jobType };
}

function targetedFact(jobType, url, facts) {
  return {
    jobType,
    url,
    normalizedUrl: url,
    finalUrl: url,
    statusCode: 200,
    contentType: 'text/html',
    indexability: 'indexable',
    facts: { url, finalUrl: url, statusCode: 200, contentType: 'text/html', indexability: 'indexable', ...facts }
  };
}

function seedMaturityCheckResults(db, runId) {
  const rows = [
    ['tech.https_reachable', 'Server', 'HTTPS reachable', 'OK', 'Low', 'info'],
    ['tech.title_missing', 'HTML', 'Title missing', 'Warning', 'High', 'core_issue'],
    ['geo.llms_txt_present', 'GEO', 'llms.txt present', 'OK', 'Low', 'info']
  ];
  for (const row of rows) {
    db.prepare(`
      INSERT INTO check_results (
        runId, checkId, category, checkName, status, priority,
        effort, finding, details, recommendation, affectedCount, sampleUrlsJson,
        evidenceJson, findingType, confidence
      )
      VALUES (?, ?, ?, ?, ?, ?, 'S', ?, ?, ?, ?, '[]', ?, ?, 'high')
    `).run(
      runId,
      row[0],
      row[1],
      row[2],
      row[3],
      row[4],
      `${row[2]} finding`,
      `${row[2]} details`,
      `${row[2]} recommendation`,
      row[3] === 'OK' ? 0 : 1,
      JSON.stringify({ status: row[3] }),
      row[5]
    );
  }
}

async function startTargetedSite() {
  const server = http.createServer((req, res) => {
    if (req.url === '/schema') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head>
        <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: 'A', filler: 'x'.repeat(3000) })}</script>
      </head><body><h1>Schema</h1></body></html>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head>
      <link rel="canonical" href="/hreflang">
      <link rel="alternate" hreflang="de-DE" href="/hreflang">
      <link rel="alternate" hreflang="x-default" href="/">
    </head><body><h1>Hreflang</h1></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function readStoredZip(buffer) {
  const entries = {};
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    entries[name] = buffer.subarray(dataStart, dataStart + compressedSize).toString('utf8');
    offset = dataStart + compressedSize;
  }
  return entries;
}
