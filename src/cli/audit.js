#!/usr/bin/env node
import { Command } from 'commander';
import { getDb, resetInterruptedWork } from '../db/database.js';
import { getRunWithProject } from '../db/repositories.js';
import { startAudit } from '../crawler/auditRunner.js';
import { crawlerDefaults } from '../crawler/defaults.js';
import { loadResultsWithScores } from '../checks/checkEngine.js';

const program = new Command();

program
  .name('audit')
  .description('Run a local SEO/GEO audit')
  .requiredOption('--domain <domain>', 'Domain to audit, for example example.com')
  .option('--brandName <brandName>', 'Optional brand name')
  .option('--maxUrls <number>', 'Maximum URLs to process', String(crawlerDefaults.maxUrls))
  .option('--maxDepth <number>', 'Maximum crawl depth', '4')
  .option('--concurrency <number>', 'Parallel workers', '2')
  .option('--maxConcurrentPerHost <number>', 'Maximum parallel requests per host', '2')
  .option('--type <type>', 'tech, geo, or both', 'both')
  .option('--respectRobotsTxt <boolean>', 'Respect robots.txt', 'true')
  .option('--crawlMode <mode>', 'hybrid, sitemap_only, internal_links_only, or template_sample', 'hybrid')
  .option('--userAgent <userAgent>', 'HTTP User-Agent header')
  .option('--robotsUserAgent <robotsUserAgent>', 'User-Agent name for robots.txt matching')
  .option('--targetPagesPerSecond <number>', 'Global target request starts per second, 0 disables rate target', '0')
  .option('--includePatterns <patterns>', 'Comma-separated include patterns')
  .option('--excludePatterns <patterns>', 'Comma-separated exclude patterns')
  .option('--crawlDelayMs <number>', 'Delay between claimed URLs per worker', '0')
  .option('--requestTimeoutMs <number>', 'Request timeout in milliseconds', '15000')
  .option('--maxAttempts <number>', 'Maximum attempts per URL', '3')
  .option('--retryBaseDelayMs <number>', 'Base retry backoff in milliseconds', '1000')
  .option('--retryMaxDelayMs <number>', 'Maximum retry backoff in milliseconds', '30000')
  .option('--maxSitemapUrls <number>', 'Maximum URLs to accept from sitemaps')
  .option('--maxSitemaps <number>', 'Maximum sitemap files to process', '100')
  .option('--sitemapBatchSize <number>', 'Sitemap queue insert batch size', '1000')
  .option('--sampleUrlsPerTemplate <number>', 'Representative sample URLs per template cluster', '5')
  .option('--maxTemplateSamplesTotal <number>', 'Maximum stored template sample URLs across all clusters', '200')
  .option('--enableTemplateSampling <boolean>', 'Enable template sample selection and optional lab sampling', 'true')
  .option('--enablePlaywrightSampling <boolean>', 'Run Playwright on template sample URLs', 'false')
  .option('--enableLighthouseSampling <boolean>', 'Run local Lighthouse on template sample URLs', 'false')
  .option('--lighthouseDevice <device>', 'mobile or desktop Lighthouse sampling', 'mobile')
  .option('--lighthouseCategories <categories>', 'Comma-separated Lighthouse categories', 'performance,accessibility,best-practices,seo')
  .option('--lighthouseTimeoutMs <number>', 'Lighthouse timeout in milliseconds', '60000')
  .option('--playwrightTimeoutMs <number>', 'Playwright sampling timeout in milliseconds', '30000')
  .option('--collectScreenshots <boolean>', 'Store Playwright sample screenshots', 'false')
  .option('--sampleOnlyIndexable <boolean>', 'Sample only indexable pages from template clusters', 'true')
  .option('--usePlaywright <boolean>', 'Enable Playwright rendering', 'false')
  .option('--playwrightMode <mode>', 'off, all, or sample', 'off')
  .option('--playwrightSampleLimit <number>', 'Maximum pages to render in sample mode', '50')
  .option('--storageProfile <profile>', 'lean, standard, or debug', 'standard')
  .option('--storeRawHtml <boolean>', 'Store capped raw HTML snapshots', 'false')
  .option('--storeRenderedHtml <boolean>', 'Store capped rendered HTML snapshots', 'false')
  .option('--maxEvidenceSamplesPerCheck <number>', 'Maximum sample/evidence rows per check', '20')
  .option('--maxStoredDetailRowsPerCheck <number>', 'Maximum detail rows returned/stored per check', '1000')
  .option('--maxRawHtmlBytesPerUrl <number>', 'Maximum raw/rendered HTML bytes per URL snapshot', '0')
  .option('--enableLlmChecks <boolean>', 'Enable optional LLM-assisted sample checks', 'false')
  .option('--llmProvider <provider>', 'none, openai, anthropic, or mock', 'none')
  .option('--llmModel <model>', 'Optional LLM model name')
  .option('--llmMaxSampleUrls <number>', 'Maximum LLM sample URLs', '5')
  .option('--llmMaxChecks <number>', 'Maximum LLM checks', '2')
  .option('--llmDryRun <boolean>', 'Build prompts without external calls', 'true')
  .parse(process.argv);

const options = program.opts();
const db = getDb();
resetInterruptedWork(db);

const { runId } = await startAudit({
  domain: options.domain,
  brandName: options.brandName,
  auditType: options.type,
  maxUrls: Number(options.maxUrls),
  maxDepth: Number(options.maxDepth),
  concurrency: Number(options.concurrency),
  maxConcurrentPerHost: Number(options.maxConcurrentPerHost),
  respectRobotsTxt: options.respectRobotsTxt !== 'false',
  crawlMode: options.crawlMode,
  userAgent: options.userAgent,
  robotsUserAgent: options.robotsUserAgent,
  targetPagesPerSecond: Number(options.targetPagesPerSecond),
  includePatterns: options.includePatterns,
  excludePatterns: options.excludePatterns,
  crawlDelayMs: Number(options.crawlDelayMs),
  requestTimeoutMs: Number(options.requestTimeoutMs),
  maxAttempts: Number(options.maxAttempts),
  retryBaseDelayMs: Number(options.retryBaseDelayMs),
  retryMaxDelayMs: Number(options.retryMaxDelayMs),
  maxSitemapUrls: options.maxSitemapUrls === undefined ? undefined : Number(options.maxSitemapUrls),
  maxSitemaps: Number(options.maxSitemaps),
  sitemapBatchSize: Number(options.sitemapBatchSize),
  sampleUrlsPerTemplate: Number(options.sampleUrlsPerTemplate),
  maxTemplateSamplesTotal: Number(options.maxTemplateSamplesTotal),
  enableTemplateSampling: options.enableTemplateSampling !== 'false',
  enablePlaywrightSampling: options.enablePlaywrightSampling === 'true',
  enableLighthouseSampling: options.enableLighthouseSampling === 'true',
  lighthouseDevice: options.lighthouseDevice,
  lighthouseCategories: options.lighthouseCategories,
  lighthouseTimeoutMs: Number(options.lighthouseTimeoutMs),
  playwrightTimeoutMs: Number(options.playwrightTimeoutMs),
  collectScreenshots: options.collectScreenshots === 'true',
  sampleOnlyIndexable: options.sampleOnlyIndexable !== 'false',
  usePlaywright: options.usePlaywright === 'true',
  playwrightMode: options.playwrightMode,
  playwrightSampleLimit: Number(options.playwrightSampleLimit),
  storageProfile: options.storageProfile,
  storeRawHtml: options.storeRawHtml === 'true',
  storeRenderedHtml: options.storeRenderedHtml === 'true',
  maxEvidenceSamplesPerCheck: Number(options.maxEvidenceSamplesPerCheck),
  maxStoredDetailRowsPerCheck: Number(options.maxStoredDetailRowsPerCheck),
  maxRawHtmlBytesPerUrl: Number(options.maxRawHtmlBytesPerUrl),
  enableLlmChecks: options.enableLlmChecks === 'true',
  llmProvider: options.llmProvider,
  llmModel: options.llmModel,
  llmMaxSampleUrls: Number(options.llmMaxSampleUrls),
  llmMaxChecks: Number(options.llmMaxChecks),
  llmDryRun: options.llmDryRun !== 'false'
}, { wait: true });

const run = getRunWithProject(db, runId);
const { scores } = loadResultsWithScores(db, runId);

console.log(`Run ${runId} ${run.status}`);
console.log(`Domain: ${run.finalDomain || run.inputDomain}`);
console.log(`Processed: ${run.processedUrls}, success: ${run.successfulUrls}, failed: ${run.failedUrls}, skipped: ${run.skippedUrls}`);
console.log(`Scores: tech=${scores.techScore ?? 'NA'} geo=${scores.geoScore ?? 'NA'} overall=${scores.overallScore ?? 'NA'}`);
console.log(`Score status: ${scores.scoreStatus || 'historical_unknown'}; weighted coverage=${scores.weightedCoverage ?? 'unknown'}%`);
console.log(`Report: reports/run-${runId}.html`);
