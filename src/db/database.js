import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const rootDir = process.cwd();

let db;
let activeDbPath;

export function getDb() {
  const dbPath = getConfiguredDbPath();
  if (!db) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    activeDbPath = dbPath;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    initDatabase(db);
  } else if (activeDbPath !== dbPath) {
    closeDb();
    return getDb();
  }
  return db;
}

export function getConfiguredDbPath() {
  const configured = String(process.env.AUDIT_DB_PATH || '').trim();
  if (!configured) return path.join(rootDir, 'data', 'audit.sqlite');
  return path.resolve(rootDir, configured);
}

export function initDatabase(database = getDb()) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inputDomain TEXT NOT NULL,
      finalDomain TEXT,
      brandName TEXT,
      protocolBehaviorJson TEXT,
      wwwBehaviorJson TEXT,
      redirectChainJson TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER NOT NULL,
      status TEXT NOT NULL,
      auditType TEXT NOT NULL,
      maxUrls INTEGER NOT NULL,
      maxDepth INTEGER NOT NULL,
      concurrency INTEGER NOT NULL,
      respectRobotsTxt INTEGER NOT NULL,
      currentPhase TEXT NOT NULL,
      currentUrl TEXT,
      discoveredUrls INTEGER NOT NULL DEFAULT 0,
      processedUrls INTEGER NOT NULL DEFAULT 0,
      successfulUrls INTEGER NOT NULL DEFAULT 0,
      failedUrls INTEGER NOT NULL DEFAULT 0,
      skippedUrls INTEGER NOT NULL DEFAULT 0,
      startedAt TEXT,
      finishedAt TEXT,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      errorMessage TEXT,
      crawlMode TEXT NOT NULL DEFAULT 'hybrid',
      includePatternsJson TEXT,
      excludePatternsJson TEXT,
      userAgent TEXT NOT NULL DEFAULT 'LocalSEOGeoAudit/0.1 (+localhost)',
      robotsUserAgent TEXT NOT NULL DEFAULT 'LocalSEOGeoAudit',
      targetPagesPerSecond REAL NOT NULL DEFAULT 0,
      crawlDelayMs INTEGER NOT NULL DEFAULT 0,
      requestTimeoutMs INTEGER NOT NULL DEFAULT 15000,
      usePlaywright INTEGER NOT NULL DEFAULT 0,
      playwrightMode TEXT NOT NULL DEFAULT 'off',
      playwrightSampleLimit INTEGER NOT NULL DEFAULT 50,
      renderedPagesCount INTEGER NOT NULL DEFAULT 0,
      lockToken TEXT,
      lockedAt TEXT,
      heartbeatAt TEXT,
      workerCount INTEGER NOT NULL DEFAULT 0,
      lastRecoveryAt TEXT,
      maxAttempts INTEGER NOT NULL DEFAULT 3,
      maxConcurrentPerHost INTEGER NOT NULL DEFAULT 2,
      retryBaseDelayMs INTEGER NOT NULL DEFAULT 1000,
      retryMaxDelayMs INTEGER NOT NULL DEFAULT 30000,
      maxSitemapUrls INTEGER,
      maxSitemaps INTEGER NOT NULL DEFAULT 100,
      sitemapBatchSize INTEGER NOT NULL DEFAULT 1000,
      enableTemplateSampling INTEGER NOT NULL DEFAULT 1,
      enablePlaywrightSampling INTEGER NOT NULL DEFAULT 0,
      enableLighthouseSampling INTEGER NOT NULL DEFAULT 0,
      sampleUrlsPerTemplate INTEGER NOT NULL DEFAULT 5,
      maxTemplateSamplesTotal INTEGER NOT NULL DEFAULT 200,
      lighthouseDevice TEXT NOT NULL DEFAULT 'mobile',
      lighthouseCategoriesJson TEXT,
      lighthouseTimeoutMs INTEGER NOT NULL DEFAULT 60000,
      playwrightTimeoutMs INTEGER NOT NULL DEFAULT 30000,
      collectScreenshots INTEGER NOT NULL DEFAULT 0,
      sampleOnlyIndexable INTEGER NOT NULL DEFAULT 1,
      samplesTotal INTEGER NOT NULL DEFAULT 0,
      samplesProcessed INTEGER NOT NULL DEFAULT 0,
      currentSampleUrl TEXT,
      sitemapUrlsDiscovered INTEGER NOT NULL DEFAULT 0,
      sitemapUrlsQueued INTEGER NOT NULL DEFAULT 0,
      sitemapFilesProcessed INTEGER NOT NULL DEFAULT 0,
      currentSitemapUrl TEXT,
      scheduledRunId INTEGER,
      triggerType TEXT NOT NULL DEFAULT 'manual',
      baselineRunId INTEGER,
      comparisonId INTEGER,
      sourceType TEXT NOT NULL DEFAULT 'crawl',
      crawlScaleMode TEXT NOT NULL DEFAULT 'medium',
      storageProfile TEXT NOT NULL DEFAULT 'standard',
      storeRawHtml INTEGER NOT NULL DEFAULT 0,
      storeRenderedHtml INTEGER NOT NULL DEFAULT 0,
      storeResponseHeaders INTEGER NOT NULL DEFAULT 1,
      storeAllLinks INTEGER NOT NULL DEFAULT 1,
      storeAllImages INTEGER NOT NULL DEFAULT 1,
      storeAllResources INTEGER NOT NULL DEFAULT 1,
      storeAffectedOnlyDetails INTEGER NOT NULL DEFAULT 0,
      maxEvidenceSamplesPerCheck INTEGER NOT NULL DEFAULT 20,
      maxStoredDetailRowsPerCheck INTEGER NOT NULL DEFAULT 1000,
      maxRawHtmlBytesPerUrl INTEGER NOT NULL DEFAULT 0,
      storageEstimateJson TEXT,
      importSummaryJson TEXT,
      enableLlmChecks INTEGER NOT NULL DEFAULT 0,
      llmProvider TEXT NOT NULL DEFAULT 'none',
      llmModel TEXT,
      llmMaxSampleUrls INTEGER NOT NULL DEFAULT 5,
      llmMaxChecks INTEGER NOT NULL DEFAULT 2,
      llmMaxTokens INTEGER NOT NULL DEFAULT 8000,
      llmDryRun INTEGER NOT NULL DEFAULT 1,
      llmWarningsJson TEXT,
      benchmarkSummaryJson TEXT,
      FOREIGN KEY (projectId) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS crawl_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      url TEXT NOT NULL,
      normalizedUrl TEXT NOT NULL,
      depth INTEGER NOT NULL,
      sourceUrl TEXT,
      sourceType TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      lastError TEXT,
      nextAttemptAt TEXT,
      lastStatusCode INTEGER,
      lastErrorType TEXT,
      failedReason TEXT,
      lockToken TEXT,
      shardKey TEXT,
      shardId INTEGER,
      discoveredAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      startedAt TEXT,
      finishedAt TEXT,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      url TEXT NOT NULL,
      normalizedUrl TEXT NOT NULL,
      finalUrl TEXT,
      depth INTEGER NOT NULL,
      sourceUrl TEXT,
      statusCode INTEGER,
      contentType TEXT,
      indexable INTEGER,
      noindex INTEGER NOT NULL DEFAULT 0,
      nofollow INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      titleLength INTEGER,
      metaDescription TEXT,
      metaDescriptionLength INTEGER,
      h1Json TEXT,
      h1Count INTEGER,
      h2Json TEXT,
      canonical TEXT,
      canonicalStatus TEXT,
      htmlLang TEXT,
      viewport TEXT,
      metaCharset TEXT,
      hasHeaderUtf8 INTEGER NOT NULL DEFAULT 0,
      hasMetaCharsetUtf8 INTEGER NOT NULL DEFAULT 0,
      metaRobots TEXT,
      xRobotsTag TEXT,
      wordCountRaw INTEGER,
      wordCountRendered INTEGER,
      rawTextLength INTEGER,
      renderedTextLength INTEGER,
      rawHtmlSize INTEGER,
      internalLinksCount INTEGER,
      externalLinksCount INTEGER,
      inlinkCount INTEGER,
      outlinkCount INTEGER,
      schemaTypesJson TEXT,
      imagesCount INTEGER,
      imagesWithoutAltCount INTEGER,
      responseHeadersJson TEXT,
      loadTimeMs INTEGER,
      ttfbMs INTEGER,
      consoleErrorsJson TEXT,
      renderedH1Json TEXT,
      renderedH1Count INTEGER,
      renderedLinksCount INTEGER,
      ogJson TEXT,
      favicon TEXT,
      manifest TEXT,
      featureFlagsJson TEXT,
      pageType TEXT DEFAULT 'other',
      hasTables INTEGER NOT NULL DEFAULT 0,
      hasLists INTEGER NOT NULL DEFAULT 0,
      hasFaqPattern INTEGER NOT NULL DEFAULT 0,
      hasVisibleDate INTEGER NOT NULL DEFAULT 0,
      hasAuthorPattern INTEGER NOT NULL DEFAULT 0,
      externalSourceLinksCount INTEGER NOT NULL DEFAULT 0,
      hasVideoEmbed INTEGER NOT NULL DEFAULT 0,
      cruxLcp REAL,
      cruxInp REAL,
      cruxCls REAL,
      cruxFcp REAL,
      psiPerformanceScore REAL,
      lighthousePerformanceScore REAL,
      lighthouseSeoScore REAL,
      importedSourceTypesJson TEXT,
      templateClusterId INTEGER,
      templateClusterKey TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS template_clusters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      clusterKey TEXT NOT NULL,
      pageType TEXT,
      urlPattern TEXT NOT NULL,
      urlCount INTEGER NOT NULL DEFAULT 0,
      indexableCount INTEGER NOT NULL DEFAULT 0,
      nonIndexableCount INTEGER NOT NULL DEFAULT 0,
      statusCodeSummaryJson TEXT,
      schemaTypesSummaryJson TEXT,
      avgWordCount REAL,
      avgInternalLinks REAL,
      avgExternalLinks REAL,
      sampleUrlsJson TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS scheduled_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projectId INTEGER,
      name TEXT,
      domain TEXT NOT NULL,
      brandName TEXT,
      auditType TEXT NOT NULL DEFAULT 'both',
      configJson TEXT,
      scheduleType TEXT NOT NULL DEFAULT 'manual',
      intervalValue INTEGER,
      dayOfWeek INTEGER,
      dayOfMonth INTEGER,
      timeOfDay TEXT,
      timezone TEXT,
      cronExpression TEXT,
      nextRunAt TEXT,
      isActive INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      lastRunId INTEGER,
      lastRunAt TEXT,
      baselineMode TEXT NOT NULL DEFAULT 'none',
      baselineRunId INTEGER,
      autoCompare INTEGER NOT NULL DEFAULT 0,
      lastError TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (projectId) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS page_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      sourceUrl TEXT NOT NULL,
      targetUrl TEXT NOT NULL,
      normalizedTargetUrl TEXT,
      linkType TEXT NOT NULL,
      anchorText TEXT,
      rel TEXT,
      statusCode INTEGER,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS page_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      pageUrl TEXT NOT NULL,
      imageUrl TEXT NOT NULL,
      alt TEXT,
      hasAlt INTEGER NOT NULL,
      loading TEXT,
      width TEXT,
      height TEXT,
      extension TEXT,
      sizeBytes INTEGER,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      pageUrl TEXT NOT NULL,
      resourceUrl TEXT NOT NULL,
      resourceType TEXT NOT NULL,
      statusCode INTEGER,
      sizeBytes INTEGER,
      contentType TEXT,
      isThirdParty INTEGER NOT NULL DEFAULT 0,
      responseHeadersJson TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS schemas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      pageUrl TEXT NOT NULL,
      schemaType TEXT,
      rawJson TEXT,
      parseStatus TEXT NOT NULL,
      parseError TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS domain_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      type TEXT NOT NULL,
      url TEXT NOT NULL,
      statusCode INTEGER,
      content TEXT,
      responseHeadersJson TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS page_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      pageUrl TEXT NOT NULL,
      normalizedUrl TEXT,
      rawHtml TEXT,
      renderedHtml TEXT,
      rawHtmlBytes INTEGER NOT NULL DEFAULT 0,
      renderedHtmlBytes INTEGER NOT NULL DEFAULT 0,
      rawHtmlTruncated INTEGER NOT NULL DEFAULT 0,
      renderedHtmlTruncated INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS import_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      importer TEXT NOT NULL,
      filename TEXT,
      exportType TEXT,
      rowCount INTEGER NOT NULL DEFAULT 0,
      mappedFieldsJson TEXT,
      ignoredColumnsJson TEXT,
      warningsJson TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS llm_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      checkId TEXT NOT NULL,
      sampledUrl TEXT,
      promptId TEXT NOT NULL,
      promptVersion TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      inputHash TEXT,
      verdict TEXT,
      score REAL,
      rationale TEXT,
      evidenceExcerpt TEXT,
      costEstimateJson TEXT,
      error TEXT,
      dryRun INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS check_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      checkId TEXT NOT NULL,
      category TEXT NOT NULL,
      checkName TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      effort TEXT NOT NULL,
      score INTEGER,
      finding TEXT,
      details TEXT,
      recommendation TEXT,
      affectedCount INTEGER NOT NULL DEFAULT 0,
      sampleUrlsJson TEXT,
      evidenceJson TEXT,
      reportGroupingKey TEXT,
      findingType TEXT,
      confidence TEXT,
      reviewRecommended INTEGER NOT NULL DEFAULT 0,
      relatedCheckIdsJson TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS finding_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      checkResultId INTEGER NOT NULL,
      reviewStatus TEXT NOT NULL DEFAULT 'unreviewed',
      reviewerName TEXT,
      note TEXT,
      manualStatus TEXT,
      manualPriority TEXT,
      manualEffort TEXT,
      manualFinding TEXT,
      manualRecommendation TEXT,
      actionStatus TEXT NOT NULL DEFAULT 'open',
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id),
      FOREIGN KEY (checkResultId) REFERENCES check_results(id),
      UNIQUE(checkResultId)
    );

    CREATE TABLE IF NOT EXISTS template_sample_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      templateClusterId INTEGER,
      templateClusterKey TEXT,
      url TEXT NOT NULL,
      finalUrl TEXT,
      sampleReason TEXT,
      playwrightStatus TEXT,
      lighthouseStatus TEXT,
      errorMessage TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS playwright_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      templateClusterId INTEGER,
      templateClusterKey TEXT,
      url TEXT NOT NULL,
      status TEXT NOT NULL,
      finalUrl TEXT,
      title TEXT,
      h1Count INTEGER,
      renderedWordCount INTEGER,
      renderedLinksCount INTEGER,
      rawRenderedWordDelta INTEGER,
      consoleErrorsCount INTEGER,
      consoleErrorsJson TEXT,
      networkErrorsCount INTEGER,
      networkErrorsJson TEXT,
      jsRequiredLikely INTEGER NOT NULL DEFAULT 0,
      screenshotPath TEXT,
      loadTimeMs INTEGER,
      domContentLoadedMs INTEGER,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS lighthouse_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      templateClusterId INTEGER,
      templateClusterKey TEXT,
      url TEXT NOT NULL,
      device TEXT,
      performanceScore REAL,
      accessibilityScore REAL,
      bestPracticesScore REAL,
      seoScore REAL,
      firstContentfulPaintMs REAL,
      largestContentfulPaintMs REAL,
      totalBlockingTimeMs REAL,
      cumulativeLayoutShift REAL,
      speedIndexMs REAL,
      interactiveMs REAL,
      totalByteWeight REAL,
      domSize REAL,
      auditsJson TEXT,
      errorMessage TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS template_performance_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      templateClusterId INTEGER,
      templateClusterKey TEXT,
      sampleCount INTEGER NOT NULL DEFAULT 0,
      playwrightSuccessCount INTEGER NOT NULL DEFAULT 0,
      lighthouseSuccessCount INTEGER NOT NULL DEFAULT 0,
      avgPerformanceScore REAL,
      minPerformanceScore REAL,
      avgSeoScore REAL,
      minSeoScore REAL,
      avgAccessibilityScore REAL,
      avgBestPracticesScore REAL,
      avgLcpMs REAL,
      avgTbtMs REAL,
      avgCls REAL,
      jsRequiredCount INTEGER NOT NULL DEFAULT 0,
      consoleErrorSampleCount INTEGER NOT NULL DEFAULT 0,
      worstSampleUrlsJson TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS run_comparisons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      baseRunId INTEGER NOT NULL,
      compareRunId INTEGER NOT NULL,
      baseDomain TEXT,
      compareDomain TEXT,
      status TEXT NOT NULL,
      summaryJson TEXT,
      findingsDeltaJson TEXT,
      urlDeltaJson TEXT,
      templateDeltaJson TEXT,
      performanceDeltaJson TEXT,
      regressionFindingsJson TEXT,
      warningsJson TEXT,
      scheduleContextJson TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (baseRunId) REFERENCES runs(id),
      FOREIGN KEY (compareRunId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS validation_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      referenceFilename TEXT,
      referenceFormat TEXT,
      sourceHash TEXT,
      outputDir TEXT,
      summaryJson TEXT,
      reportJson TEXT,
      benchmarkSummaryJson TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runId INTEGER NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      dataJson TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (runId) REFERENCES runs(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_crawl_queue_run_normalized
      ON crawl_queue(runId, normalizedUrl);
    CREATE INDEX IF NOT EXISTS idx_crawl_queue_run_status_priority
      ON crawl_queue(runId, status, priority);
    CREATE INDEX IF NOT EXISTS idx_pages_run_normalized
      ON pages(runId, normalizedUrl);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_run_normalized_unique
      ON pages(runId, normalizedUrl);
    CREATE INDEX IF NOT EXISTS idx_pages_run_status
      ON pages(runId, statusCode);
    CREATE INDEX IF NOT EXISTS idx_check_results_run_status
      ON check_results(runId, status);
    CREATE INDEX IF NOT EXISTS idx_check_results_run_priority
      ON check_results(runId, priority);
    CREATE INDEX IF NOT EXISTS idx_finding_reviews_run
      ON finding_reviews(runId);
    CREATE INDEX IF NOT EXISTS idx_finding_reviews_check_result
      ON finding_reviews(checkResultId);
    CREATE INDEX IF NOT EXISTS idx_page_links_run_source
      ON page_links(runId, sourceUrl);
    CREATE INDEX IF NOT EXISTS idx_page_links_run_target
      ON page_links(runId, normalizedTargetUrl);
    CREATE INDEX IF NOT EXISTS idx_resources_run_page
      ON resources(runId, pageUrl);
    CREATE INDEX IF NOT EXISTS idx_schemas_run_type
      ON schemas(runId, schemaType);
    CREATE INDEX IF NOT EXISTS idx_page_snapshots_run_url
      ON page_snapshots(runId, normalizedUrl);
    CREATE INDEX IF NOT EXISTS idx_import_files_run
      ON import_files(runId);
    CREATE INDEX IF NOT EXISTS idx_llm_results_run
      ON llm_results(runId, checkId);
    CREATE INDEX IF NOT EXISTS idx_template_clusters_run_key
      ON template_clusters(runId, clusterKey);
    CREATE INDEX IF NOT EXISTS idx_template_sample_results_run
      ON template_sample_results(runId, templateClusterKey);
    CREATE INDEX IF NOT EXISTS idx_playwright_results_run
      ON playwright_results(runId, templateClusterKey);
    CREATE INDEX IF NOT EXISTS idx_lighthouse_results_run
      ON lighthouse_results(runId, templateClusterKey);
    CREATE INDEX IF NOT EXISTS idx_template_performance_summary_run
      ON template_performance_summary(runId, templateClusterKey);
    CREATE INDEX IF NOT EXISTS idx_run_comparisons_runs
      ON run_comparisons(baseRunId, compareRunId);
    CREATE INDEX IF NOT EXISTS idx_validation_reports_run
      ON validation_reports(runId, id);
  `);

  ensureColumns(database, 'pages', [
    ['pageType', "TEXT DEFAULT 'other'"],
    ['noindex', 'INTEGER NOT NULL DEFAULT 0'],
    ['nofollow', 'INTEGER NOT NULL DEFAULT 0'],
    ['canonicalStatus', 'TEXT'],
    ['metaCharset', 'TEXT'],
    ['hasHeaderUtf8', 'INTEGER NOT NULL DEFAULT 0'],
    ['hasMetaCharsetUtf8', 'INTEGER NOT NULL DEFAULT 0'],
    ['hasTables', 'INTEGER NOT NULL DEFAULT 0'],
    ['hasLists', 'INTEGER NOT NULL DEFAULT 0'],
    ['hasFaqPattern', 'INTEGER NOT NULL DEFAULT 0'],
    ['hasVisibleDate', 'INTEGER NOT NULL DEFAULT 0'],
    ['hasAuthorPattern', 'INTEGER NOT NULL DEFAULT 0'],
    ['externalSourceLinksCount', 'INTEGER NOT NULL DEFAULT 0'],
    ['hasVideoEmbed', 'INTEGER NOT NULL DEFAULT 0'],
    ['inlinkCount', 'INTEGER'],
    ['outlinkCount', 'INTEGER'],
    ['cruxLcp', 'REAL'],
    ['cruxInp', 'REAL'],
    ['cruxCls', 'REAL'],
    ['cruxFcp', 'REAL'],
    ['psiPerformanceScore', 'REAL'],
    ['lighthousePerformanceScore', 'REAL'],
    ['lighthouseSeoScore', 'REAL'],
    ['importedSourceTypesJson', 'TEXT'],
    ['templateClusterId', 'INTEGER'],
    ['templateClusterKey', 'TEXT']
  ]);

  ensureColumns(database, 'runs', [
    ['crawlMode', "TEXT NOT NULL DEFAULT 'hybrid'"],
    ['includePatternsJson', 'TEXT'],
    ['excludePatternsJson', 'TEXT'],
    ['userAgent', "TEXT NOT NULL DEFAULT 'LocalSEOGeoAudit/0.1 (+localhost)'"],
    ['robotsUserAgent', "TEXT NOT NULL DEFAULT 'LocalSEOGeoAudit'"],
    ['targetPagesPerSecond', 'REAL NOT NULL DEFAULT 0'],
    ['crawlDelayMs', 'INTEGER NOT NULL DEFAULT 0'],
    ['requestTimeoutMs', 'INTEGER NOT NULL DEFAULT 15000'],
    ['usePlaywright', 'INTEGER NOT NULL DEFAULT 0'],
    ['playwrightMode', "TEXT NOT NULL DEFAULT 'off'"],
    ['playwrightSampleLimit', 'INTEGER NOT NULL DEFAULT 50'],
    ['renderedPagesCount', 'INTEGER NOT NULL DEFAULT 0'],
    ['lockToken', 'TEXT'],
    ['lockedAt', 'TEXT'],
    ['heartbeatAt', 'TEXT'],
    ['workerCount', 'INTEGER NOT NULL DEFAULT 0'],
    ['lastRecoveryAt', 'TEXT'],
    ['maxAttempts', 'INTEGER NOT NULL DEFAULT 3'],
    ['maxConcurrentPerHost', 'INTEGER NOT NULL DEFAULT 2'],
    ['retryBaseDelayMs', 'INTEGER NOT NULL DEFAULT 1000'],
    ['retryMaxDelayMs', 'INTEGER NOT NULL DEFAULT 30000'],
    ['maxSitemapUrls', 'INTEGER'],
    ['maxSitemaps', 'INTEGER NOT NULL DEFAULT 100'],
    ['sitemapBatchSize', 'INTEGER NOT NULL DEFAULT 1000'],
    ['enableTemplateSampling', 'INTEGER NOT NULL DEFAULT 1'],
    ['enablePlaywrightSampling', 'INTEGER NOT NULL DEFAULT 0'],
    ['enableLighthouseSampling', 'INTEGER NOT NULL DEFAULT 0'],
    ['sampleUrlsPerTemplate', 'INTEGER NOT NULL DEFAULT 5'],
    ['maxTemplateSamplesTotal', 'INTEGER NOT NULL DEFAULT 200'],
    ['lighthouseDevice', "TEXT NOT NULL DEFAULT 'mobile'"],
    ['lighthouseCategoriesJson', 'TEXT'],
    ['lighthouseTimeoutMs', 'INTEGER NOT NULL DEFAULT 60000'],
    ['playwrightTimeoutMs', 'INTEGER NOT NULL DEFAULT 30000'],
    ['collectScreenshots', 'INTEGER NOT NULL DEFAULT 0'],
    ['sampleOnlyIndexable', 'INTEGER NOT NULL DEFAULT 1'],
    ['samplesTotal', 'INTEGER NOT NULL DEFAULT 0'],
    ['samplesProcessed', 'INTEGER NOT NULL DEFAULT 0'],
    ['currentSampleUrl', 'TEXT'],
    ['sitemapUrlsDiscovered', 'INTEGER NOT NULL DEFAULT 0'],
    ['sitemapUrlsQueued', 'INTEGER NOT NULL DEFAULT 0'],
    ['sitemapFilesProcessed', 'INTEGER NOT NULL DEFAULT 0'],
    ['currentSitemapUrl', 'TEXT'],
    ['scheduledRunId', 'INTEGER'],
    ['triggerType', "TEXT NOT NULL DEFAULT 'manual'"],
    ['baselineRunId', 'INTEGER'],
    ['comparisonId', 'INTEGER'],
    ['sourceType', "TEXT NOT NULL DEFAULT 'crawl'"],
    ['crawlScaleMode', "TEXT NOT NULL DEFAULT 'medium'"],
    ['storageProfile', "TEXT NOT NULL DEFAULT 'standard'"],
    ['storeRawHtml', 'INTEGER NOT NULL DEFAULT 0'],
    ['storeRenderedHtml', 'INTEGER NOT NULL DEFAULT 0'],
    ['storeResponseHeaders', 'INTEGER NOT NULL DEFAULT 1'],
    ['storeAllLinks', 'INTEGER NOT NULL DEFAULT 1'],
    ['storeAllImages', 'INTEGER NOT NULL DEFAULT 1'],
    ['storeAllResources', 'INTEGER NOT NULL DEFAULT 1'],
    ['storeAffectedOnlyDetails', 'INTEGER NOT NULL DEFAULT 0'],
    ['maxEvidenceSamplesPerCheck', 'INTEGER NOT NULL DEFAULT 20'],
    ['maxStoredDetailRowsPerCheck', 'INTEGER NOT NULL DEFAULT 1000'],
    ['maxRawHtmlBytesPerUrl', 'INTEGER NOT NULL DEFAULT 0'],
    ['storageEstimateJson', 'TEXT'],
    ['importSummaryJson', 'TEXT'],
    ['enableLlmChecks', 'INTEGER NOT NULL DEFAULT 0'],
    ['llmProvider', "TEXT NOT NULL DEFAULT 'none'"],
    ['llmModel', 'TEXT'],
    ['llmMaxSampleUrls', 'INTEGER NOT NULL DEFAULT 5'],
    ['llmMaxChecks', 'INTEGER NOT NULL DEFAULT 2'],
    ['llmMaxTokens', 'INTEGER NOT NULL DEFAULT 8000'],
    ['llmDryRun', 'INTEGER NOT NULL DEFAULT 1'],
    ['llmWarningsJson', 'TEXT'],
    ['benchmarkSummaryJson', 'TEXT']
  ]);

  ensureColumns(database, 'scheduled_runs', [
    ['name', 'TEXT'],
    ['intervalValue', 'INTEGER'],
    ['dayOfWeek', 'INTEGER'],
    ['dayOfMonth', 'INTEGER'],
    ['timeOfDay', 'TEXT'],
    ['timezone', 'TEXT'],
    ['isActive', 'INTEGER NOT NULL DEFAULT 1'],
    ['lastRunId', 'INTEGER'],
    ['lastRunAt', 'TEXT'],
    ['baselineMode', "TEXT NOT NULL DEFAULT 'none'"],
    ['baselineRunId', 'INTEGER'],
    ['autoCompare', 'INTEGER NOT NULL DEFAULT 0'],
    ['lastError', 'TEXT']
  ]);

  ensureColumns(database, 'crawl_queue', [
    ['nextAttemptAt', 'TEXT'],
    ['lastStatusCode', 'INTEGER'],
    ['lastErrorType', 'TEXT'],
    ['failedReason', 'TEXT'],
    ['lockToken', 'TEXT'],
    ['shardKey', 'TEXT'],
    ['shardId', 'INTEGER']
  ]);

  ensureColumns(database, 'page_images', [
    ['likelyDecorativeImage', 'INTEGER NOT NULL DEFAULT 0'],
    ['likelyBadgeImage', 'INTEGER NOT NULL DEFAULT 0'],
    ['likelyTrackingPixel', 'INTEGER NOT NULL DEFAULT 0'],
    ['likelyIcon', 'INTEGER NOT NULL DEFAULT 0'],
    ['imageRole', 'TEXT']
  ]);

  ensureColumns(database, 'check_results', [
    ['reportGroupingKey', 'TEXT'],
    ['findingType', 'TEXT'],
    ['confidence', 'TEXT'],
    ['reviewRecommended', 'INTEGER NOT NULL DEFAULT 0'],
    ['relatedCheckIdsJson', 'TEXT']
  ]);

  ensureColumns(database, 'run_comparisons', [
    ['regressionFindingsJson', 'TEXT'],
    ['scheduleContextJson', 'TEXT']
  ]);

  database.prepare(`
    UPDATE scheduled_runs
    SET isActive = enabled
    WHERE enabled IN (0, 1)
      AND isActive IN (0, 1)
      AND enabled <> isActive
  `).run();

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_pages_run_page_type
      ON pages(runId, pageType);
    CREATE INDEX IF NOT EXISTS idx_runs_status
      ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_crawl_queue_run_waiting
      ON crawl_queue(runId, status, nextAttemptAt);
    CREATE INDEX IF NOT EXISTS idx_crawl_queue_run_shard
      ON crawl_queue(runId, shardId, status);
    CREATE INDEX IF NOT EXISTS idx_pages_run_template
      ON pages(runId, templateClusterId);
    CREATE INDEX IF NOT EXISTS idx_template_clusters_run_key
      ON template_clusters(runId, clusterKey);
    CREATE INDEX IF NOT EXISTS idx_finding_reviews_run_status
      ON finding_reviews(runId, reviewStatus, actionStatus);
    CREATE INDEX IF NOT EXISTS idx_template_sample_results_run
      ON template_sample_results(runId, templateClusterKey);
    CREATE INDEX IF NOT EXISTS idx_playwright_results_run
      ON playwright_results(runId, templateClusterKey);
    CREATE INDEX IF NOT EXISTS idx_lighthouse_results_run
      ON lighthouse_results(runId, templateClusterKey);
    CREATE INDEX IF NOT EXISTS idx_template_performance_summary_run
      ON template_performance_summary(runId, templateClusterKey);
    CREATE INDEX IF NOT EXISTS idx_run_comparisons_runs
      ON run_comparisons(baseRunId, compareRunId);
    CREATE INDEX IF NOT EXISTS idx_scheduled_runs_due
      ON scheduled_runs(isActive, nextRunAt);
    CREATE INDEX IF NOT EXISTS idx_scheduled_runs_last_run
      ON scheduled_runs(lastRunId);
    CREATE INDEX IF NOT EXISTS idx_runs_scheduled_run
      ON runs(scheduledRunId, status);
    CREATE INDEX IF NOT EXISTS idx_runs_source_type
      ON runs(sourceType, status);
    CREATE INDEX IF NOT EXISTS idx_page_snapshots_run_url
      ON page_snapshots(runId, normalizedUrl);
    CREATE INDEX IF NOT EXISTS idx_import_files_run
      ON import_files(runId);
    CREATE INDEX IF NOT EXISTS idx_llm_results_run
      ON llm_results(runId, checkId);
    CREATE INDEX IF NOT EXISTS idx_validation_reports_run
      ON validation_reports(runId, id);
  `);
}

function ensureColumns(database, table, columns) {
  const existing = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  for (const [name, definition] of columns) {
    if (!existing.has(name)) {
      database.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run();
    }
  }
}

export function resetInterruptedWork(database = getDb()) {
  database.prepare(`
    UPDATE crawl_queue
    SET status = 'pending',
        startedAt = NULL,
        lockToken = NULL,
        nextAttemptAt = NULL,
        lastError = COALESCE(lastError, 'Reset after interrupted process')
    WHERE status = 'processing'
  `).run();

  database.prepare(`
    UPDATE runs
    SET status = 'paused',
        currentPhase = CASE WHEN currentPhase = 'completed' THEN currentPhase ELSE 'crawling' END,
        currentUrl = NULL,
        lockToken = NULL,
        workerCount = 0,
        updatedAt = CURRENT_TIMESTAMP
    WHERE status = 'running'
  `).run();
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
    activeDbPath = undefined;
  }
}
