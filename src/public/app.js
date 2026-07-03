import { createSunburstLayout, maturityLegend, scoreToColor, sunburstArcPath, polarToXY } from './sunburst.js';

const app = document.querySelector('#app');
let pollTimer = null;
let resultsState = {
  status: '',
  priority: '',
  findingType: '',
  confidence: '',
  reviewRecommended: '',
  reviewStatus: '',
  actionStatus: '',
  category: '',
  needsReview: false,
  quickFilter: '',
  search: '',
  sort: 'recommended',
  page: 1
};
let currentRunId = null;
let currentResults = [];
let currentResultsById = new Map();
let currentMaturityByCheckId = new Map();
let currentMaturityByCheckResultId = new Map();
let selectedFindings = new Set();
let currentCapabilities = null;
let pendingMaturityAutoRedirectRunId = null;

initTheme();
setupShellNavigation();
window.addEventListener('hashchange', route);
route();

function initTheme() {
  const savedTheme = localStorage.getItem('omfire-audit-theme');
  const theme = savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : 'light';
  document.documentElement.dataset.theme = theme;
  document.querySelector('#theme-toggle')?.addEventListener('click', () => {
    const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem('omfire-audit-theme', nextTheme);
  });
}

function setupShellNavigation() {
  document.querySelector('#runs-nav')?.addEventListener('click', async () => {
    window.location.hash = '';
    await route();
    const panel = document.querySelector('#latest-runs-panel');
    if (!panel) return;
    panel.hidden = false;
    await loadRuns(8);
  });
}

async function route() {
  clearPoll();
  const hash = window.location.hash.replace(/^#/, '');
  const [view, id, subview, subid] = hash.split('/');
  if (view === 'run' && id) return renderRun(Number(id));
  if (view === 'results' && id) {
    return renderResults(Number(id), {
      openCheckResultId: subview === 'check' && subid ? Number(subid) : null
    });
  }
  if ((view === 'maturity' || view === 'reifegrad') && id) return renderMaturity(Number(id));
  if (view === 'validation' && id) return renderValidation(Number(id));
  if (view === 'schedules') return renderSchedules();
  return renderHomeV2();
}

async function renderHome() {
  app.innerHTML = `
    <section class="grid two">
      <form id="start-form" class="panel">
        <h2>Audit starten</h2>
        <label>Domain
          <input name="domain" placeholder="example.com" required>
        </label>
        <label>Brand Name
          <input name="brandName" placeholder="Optional">
        </label>
        <div class="form-row">
          <label>Audit Type
            <select name="auditType">
              <option value="both">Tech + GEO</option>
              <option value="tech">Tech</option>
              <option value="geo">GEO</option>
            </select>
          </label>
          <label>Robots
            <select name="respectRobotsTxt">
              <option value="true">respect</option>
              <option value="false">ignore</option>
            </select>
          </label>
        </div>
        <label>Crawl Mode
          <select name="crawlMode">
            <option value="hybrid">hybrid</option>
            <option value="sitemap_only">sitemap only</option>
            <option value="internal_links_only">internal links only</option>
          </select>
        </label>
        <label>Include Patterns
          <input name="includePatterns" placeholder="Optional, comma-separated">
        </label>
        <label>Exclude Patterns
          <input name="excludePatterns" placeholder="Optional, comma-separated">
        </label>
        <div class="form-row">
          <label>maxUrls
            <input name="maxUrls" type="number" min="1" value="5000">
          </label>
          <label>maxDepth
            <input name="maxDepth" type="number" min="0" value="4">
          </label>
        </div>
        <div class="form-row">
          <label>Concurrency
            <input name="concurrency" type="number" min="1" max="10" value="2">
          </label>
          <label>Per Host
            <input name="maxConcurrentPerHost" type="number" min="1" max="10" value="2">
          </label>
        </div>
        <div class="form-row">
          <label>Crawl Delay ms
            <input name="crawlDelayMs" type="number" min="0" value="0">
          </label>
          <label>Request Timeout ms
            <input name="requestTimeoutMs" type="number" min="1000" value="15000">
          </label>
        </div>
        <div class="form-row">
          <label>Use Playwright
            <select name="usePlaywright">
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
          </label>
          <label>Playwright Mode
            <select name="playwrightMode">
              <option value="off">off</option>
              <option value="all">all</option>
              <option value="sample">sample</option>
            </select>
          </label>
        </div>
        <label>Playwright Sample Limit
          <input name="playwrightSampleLimit" type="number" min="0" value="50">
        </label>
        <div class="form-row">
          <label>Max Attempts
            <input name="maxAttempts" type="number" min="1" max="10" value="3">
          </label>
          <label>Retry Base ms
            <input name="retryBaseDelayMs" type="number" min="0" value="1000">
          </label>
        </div>
        <label>Retry Max ms
          <input name="retryMaxDelayMs" type="number" min="0" value="30000">
        </label>
        <div class="form-row">
          <label>Max Sitemaps
            <input name="maxSitemaps" type="number" min="1" value="100">
          </label>
          <label>Sitemap Batch
            <input name="sitemapBatchSize" type="number" min="1" value="1000">
          </label>
        </div>
        <label>Max Sitemap URLs
          <input name="maxSitemapUrls" type="number" min="0" placeholder="Optional">
        </label>
        <div class="form-row">
          <label>Samples / Template
            <input name="sampleUrlsPerTemplate" type="number" min="1" value="5">
          </label>
          <label>Max Template Samples
            <input name="maxTemplateSamplesTotal" type="number" min="1" value="200">
          </label>
        </div>
        <div class="form-row">
          <label>Template Sampling
            <select name="enableTemplateSampling">
              <option value="true">enabled</option>
              <option value="false">disabled</option>
            </select>
          </label>
          <label>Indexable Samples Only
            <select name="sampleOnlyIndexable">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </label>
        </div>
        <div class="form-row">
          <label>Playwright Sampling
            <select name="enablePlaywrightSampling">
              <option value="false">disabled</option>
              <option value="true">enabled</option>
            </select>
          </label>
          <label>Playwright Timeout ms
            <input name="playwrightTimeoutMs" type="number" min="1000" value="30000">
          </label>
        </div>
        <div class="form-row">
          <label>Lighthouse Sampling
            <select name="enableLighthouseSampling">
              <option value="false">disabled</option>
              <option value="true">enabled</option>
            </select>
          </label>
          <label>Lighthouse Device
            <select name="lighthouseDevice">
              <option value="mobile">mobile</option>
              <option value="desktop">desktop</option>
            </select>
          </label>
        </div>
        <label>Lighthouse Categories
          <input name="lighthouseCategories" value="performance,accessibility,best-practices,seo">
        </label>
        <div class="form-row">
          <label>Lighthouse Timeout ms
            <input name="lighthouseTimeoutMs" type="number" min="1000" value="60000">
          </label>
          <label>Collect Screenshots
            <select name="collectScreenshots">
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
          </label>
        </div>
        <div class="actions">
          <button class="primary" type="submit">Audit starten</button>
          <span id="form-message" class="muted"></span>
        </div>
      </form>
      <section class="panel">
        <div class="actions" style="justify-content: space-between;">
          <h2>Bisherige Runs</h2>
          <a class="button" href="#schedules">Monitoring / Schedules</a>
        </div>
        <div id="runs"></div>
      </section>
    </section>
  `;

  document.querySelector('#start-form').addEventListener('submit', startAudit);
  await loadRuns();
}

async function renderHomeV2() {
  app.innerHTML = `
    <section class="start-layout">
      <form id="start-form" class="panel start-panel">
        <div class="start-copy">
          <div class="eyebrow">OMfire! Audit Workspace</div>
          <h2>OMfire! SEO &amp; GEO Audit</h2>
          <p>Technische SEO-, GEO- und AI-Search-Prüfpunkte in einem exportierbaren Audit-Workspace.</p>
        </div>
        <label class="url-field">URL oder Domain
          <input name="domain" placeholder="https://example.com" required>
        </label>
        <div class="mode-grid" role="group" aria-label="Audit Modus">
          <label class="mode-option"><input type="radio" name="auditMode" value="quick"><span>Schnellcheck</span></label>
          <label class="mode-option"><input type="radio" name="auditMode" value="full" checked><span>Full Audit</span><small>Vollaudit</small></label>
          <label class="mode-option"><input type="radio" name="auditMode" value="tech"><span>Tech only</span></label>
          <label class="mode-option"><input type="radio" name="auditMode" value="geo"><span>GEO only</span></label>
        </div>
        ${hiddenAuditInputs()}
        <div class="actions start-actions">
          <button class="primary big-start" type="submit">Full Audit starten</button>
          <button id="advanced-open" class="secondary" type="button">Advanced Settings</button>
          <button id="latest-runs-toggle" class="secondary" type="button">Letzte Läufe</button>
          <a class="button ghost secondary-link" href="#schedules">Monitoring</a>
          <span id="form-message" class="muted"></span>
        </div>
        <div id="capabilities" class="capability-panel muted">Prüfe lokale Full-Audit-Capabilities...</div>
      </form>
      <section class="panel import-panel">
        <div class="eyebrow">Screaming Frog Import</div>
        <h2>CSV-Export importieren</h2>
        <form id="sf-import-form">
          <label>Domain
            <input name="importDomain" placeholder="https://example.com">
          </label>
          <label>CSV-Dateien
            <input name="files" type="file" accept=".csv,text/csv" multiple required>
          </label>
          <div class="form-row">
            <label>Storage Profile
              <select name="storageProfile">
                <option value="standard">standard</option>
                <option value="lean">lean</option>
                <option value="debug">debug</option>
              </select>
            </label>
            <label>Audit Type
              <select name="auditType">
                <option value="both">Tech + GEO</option>
                <option value="tech">Tech</option>
                <option value="geo">GEO</option>
              </select>
            </label>
          </div>
          <div class="actions">
            <button class="primary" type="submit">Import starten</button>
            <span id="sf-import-message" class="muted"></span>
          </div>
        </form>
      </section>
      <section id="latest-runs-panel" class="panel compact-runs" hidden>
        <div class="actions" style="justify-content: space-between;">
          <h2>Letzte Läufe</h2>
          <a class="button" href="#schedules">Monitoring / Schedules</a>
        </div>
        <div id="runs"></div>
      </section>
    </section>
	    <div id="advanced-modal" class="modal" hidden>
	      <div class="modal-card settings-card">
        <div class="actions" style="justify-content: space-between;">
          <h2>Advanced Settings</h2>
          <button id="advanced-close" type="button">Schließen</button>
        </div>
	        <div id="advanced-capabilities" class="capability-panel muted"></div>
	        <div id="advanced-fields" class="settings-grid"></div>
	      </div>
	    </div>
	  `;

	  document.querySelector('#start-form').addEventListener('submit', startAudit);
	  document.querySelector('#sf-import-form')?.addEventListener('submit', startScreamingFrogImport);
	  setupAuditModeDefaults();
	  setupAdvancedSettings();
	  loadCapabilities();
  document.querySelector('#latest-runs-toggle').addEventListener('click', async () => {
    const panel = document.querySelector('#latest-runs-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) await loadRuns(8);
  });
}

function hiddenAuditInputs() {
  const defaults = {
    brandName: '',
    auditType: 'both',
    maxUrls: 5000,
    maxDepth: 4,
    concurrency: 2,
    maxConcurrentPerHost: 2,
    userAgent: 'LocalSEOGeoAudit/0.1 (+localhost)',
    robotsUserAgent: 'LocalSEOGeoAudit',
    targetPagesPerSecond: 0,
    respectRobotsTxt: 'true',
    crawlMode: 'hybrid',
    includePatterns: '',
    excludePatterns: '',
    crawlDelayMs: 0,
    requestTimeoutMs: 15000,
    usePlaywright: 'true',
    playwrightMode: 'all',
    playwrightSampleLimit: 50,
    maxAttempts: 3,
    retryBaseDelayMs: 1000,
    retryMaxDelayMs: 30000,
    maxSitemaps: 100,
    sitemapBatchSize: 1000,
    maxSitemapUrls: '',
    sampleUrlsPerTemplate: 5,
    maxTemplateSamplesTotal: 200,
    enableTemplateSampling: 'true',
    sampleOnlyIndexable: 'true',
    enablePlaywrightSampling: 'true',
    playwrightTimeoutMs: 30000,
    enableLighthouseSampling: 'true',
    lighthouseDevice: 'mobile',
    lighthouseCategories: 'performance,accessibility,best-practices,seo',
    lighthouseTimeoutMs: 60000,
    collectScreenshots: 'false'
    ,
    storageProfile: 'standard',
    storeRawHtml: 'false',
    storeRenderedHtml: 'false',
    storeResponseHeaders: 'true',
    storeAllLinks: 'true',
    storeAllImages: 'true',
    storeAllResources: 'true',
    storeAffectedOnlyDetails: 'false',
    maxEvidenceSamplesPerCheck: 20,
    maxStoredDetailRowsPerCheck: 1000,
    maxRawHtmlBytesPerUrl: 0,
    enableLlmChecks: 'false',
    llmProvider: 'none',
    llmModel: '',
    llmMaxSampleUrls: 5,
    llmMaxChecks: 2,
    llmMaxTokens: 8000,
    llmDryRun: 'true'
  };
  return Object.entries(defaults)
    .map(([name, value]) => `<input name="${name}" type="hidden" value="${escapeHtml(value)}">`)
    .join('');
}

function setupAuditModeDefaults() {
  const form = document.querySelector('#start-form');
  const presets = {
    quick: {
      auditType: 'both',
      crawlMode: 'hybrid',
      maxUrls: 50,
      maxDepth: 2,
      concurrency: 2,
      respectRobotsTxt: 'true',
      usePlaywright: 'false',
      playwrightMode: 'off',
      enableTemplateSampling: 'true',
      enablePlaywrightSampling: 'false',
      enableLighthouseSampling: 'false',
      sampleUrlsPerTemplate: 5
    },
    full: {
      auditType: 'both',
      crawlMode: 'hybrid',
      maxUrls: 5000,
      maxDepth: 4,
      concurrency: 2,
      respectRobotsTxt: 'true',
      usePlaywright: 'true',
      playwrightMode: 'all',
      enableTemplateSampling: 'true',
      enablePlaywrightSampling: 'true',
      enableLighthouseSampling: 'true',
      sampleUrlsPerTemplate: 5,
      sampleOnlyIndexable: 'true'
    },
    tech: {
      auditType: 'tech',
      crawlMode: 'hybrid',
      maxUrls: 250,
      maxDepth: 3,
      concurrency: 2,
      respectRobotsTxt: 'true',
      usePlaywright: 'true',
      playwrightMode: 'sample',
      enableTemplateSampling: 'true',
      enablePlaywrightSampling: 'true',
      enableLighthouseSampling: 'false',
      sampleUrlsPerTemplate: 5
    },
    geo: {
      auditType: 'geo',
      crawlMode: 'hybrid',
      maxUrls: 250,
      maxDepth: 3,
      concurrency: 2,
      respectRobotsTxt: 'true',
      usePlaywright: 'false',
      playwrightMode: 'off',
      enableTemplateSampling: 'true',
      enablePlaywrightSampling: 'false',
      enableLighthouseSampling: 'false',
      sampleUrlsPerTemplate: 5
    }
  };
  for (const input of form.querySelectorAll('input[name="auditMode"]')) {
    input.addEventListener('change', () => {
      const preset = presets[input.value] || presets.quick;
      for (const [name, value] of Object.entries(preset)) {
        const field = form.elements[name];
        if (field) field.value = value;
      }
    });
  }
}

function setupAdvancedSettings() {
  const form = document.querySelector('#start-form');
  const modal = document.querySelector('#advanced-modal');
  const fields = document.querySelector('#advanced-fields');
  fields.innerHTML = advancedFieldMarkup(form);
  document.querySelector('#advanced-open').addEventListener('click', () => { modal.hidden = false; });
  document.querySelector('#advanced-close').addEventListener('click', () => { modal.hidden = true; });
  fields.addEventListener('input', syncAdvancedField);
  fields.addEventListener('change', syncAdvancedField);
  fields.addEventListener('input', debounceStorageEstimate);
  fields.addEventListener('change', debounceStorageEstimate);
  updateStorageEstimate();
}

async function loadCapabilities() {
  try {
    currentCapabilities = await fetchJson('/api/capabilities');
    renderCapabilities(currentCapabilities);
  } catch (error) {
    renderCapabilities({ error: error.message, hints: [{ message: 'Capability check failed', fix: error.message }] });
  }
}

function renderCapabilities(capabilities) {
  const containers = ['#capabilities', '#advanced-capabilities']
    .map((selector) => document.querySelector(selector))
    .filter(Boolean);
  const hints = capabilities.hints || [];
  const ok = capabilities.fullAuditMode?.available;
  const warning = capabilities.fullAuditMode?.availableWithWarnings;
  const html = `
    <strong>Full Audit lokal: ${ok ? 'bereit' : warning ? 'ohne Lighthouse vollständig' : 'eingeschränkt'}</strong>
    <span>Playwright: ${capabilityLabel(capabilities.playwrightPackage)} · Chromium: ${capabilityLabel(capabilities.chromium)} · Lighthouse Package: ${capabilityLabel(capabilities.lighthousePackage)} · chrome-launcher: ${capabilityLabel(capabilities.chromeLauncherPackage)} · Lighthouse Sampling: ${capabilityLabel(capabilities.lighthouseSampling)} · ZIP: ${capabilityLabel(capabilities.zipExport)}</span>
    ${hints.length ? `<ul>${hints.map((item) => `<li>${escapeHtml(item.message)} · <code>${escapeHtml(item.fix)}</code></li>`).join('')}</ul>` : ''}
  `;
  for (const container of containers) container.innerHTML = html;
}

function capabilityLabel(value = {}) {
  return value.available || value.ok ? 'ok' : 'unavailable';
}

function syncAdvancedField(event) {
  const source = event.target;
  if (!source.name) return;
  const target = document.querySelector(`#start-form [name="${source.name}"]`);
  if (target) target.value = source.value;
}

let storageEstimateTimer = null;
function debounceStorageEstimate() {
  clearTimeout(storageEstimateTimer);
  storageEstimateTimer = setTimeout(updateStorageEstimate, 250);
}

async function updateStorageEstimate() {
  const form = document.querySelector('#start-form');
  const hint = document.querySelector('#storage-estimate-hint');
  if (!form || !hint) return;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    const payload = await fetchJson('/api/audits/storage-estimate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data)
    });
    const estimate = payload.estimate || {};
    const warnings = estimate.warnings || [];
    hint.innerHTML = `Scale: ${escapeHtml(estimate.crawlScaleMode || '')} · grob ${escapeHtml(String(estimate.estimatedMb || 0))} MB · Risiko ${escapeHtml(estimate.riskLevel || 'low')}${warnings.length ? `<br>${warnings.map(escapeHtml).join('<br>')}` : ''}`;
  } catch {
    hint.textContent = '';
  }
}

function advancedFieldMarkup(form) {
  const value = (name) => escapeHtml(form.elements[name]?.value || '');
  return `
    <label>Brand Name<input name="brandName" value="${value('brandName')}"></label>
    <label>maxUrls<input name="maxUrls" type="number" min="1" value="${value('maxUrls')}"><small>${largeAuditHint(Number(value('maxUrls') || 0))}</small></label>
    <label>maxDepth<input name="maxDepth" type="number" min="0" value="${value('maxDepth')}"></label>
    <label>Concurrency<input name="concurrency" type="number" min="1" max="10" value="${value('concurrency')}"></label>
    <label>Pages / Second<input name="targetPagesPerSecond" type="number" min="0" step="0.1" value="${value('targetPagesPerSecond')}"><small>0 = kein globales Start-Limit</small></label>
    <label>User-Agent<input name="userAgent" value="${value('userAgent')}"></label>
    <label>Robots User-Agent<input name="robotsUserAgent" value="${value('robotsUserAgent')}"></label>
    <label>Respect robots.txt<select name="respectRobotsTxt">${option('true', 'respect', value('respectRobotsTxt'))}${option('false', 'ignore', value('respectRobotsTxt'))}</select></label>
    <label>Crawl Mode<select name="crawlMode">${option('hybrid', 'hybrid', value('crawlMode'))}${option('template_sample', 'template sample', value('crawlMode'))}${option('sitemap_only', 'sitemap only', value('crawlMode'))}${option('internal_links_only', 'internal links only', value('crawlMode'))}</select></label>
    <label>Include Patterns<input name="includePatterns" value="${value('includePatterns')}"></label>
    <label>Exclude Patterns<input name="excludePatterns" value="${value('excludePatterns')}"></label>
    <label>Use Playwright<select name="usePlaywright">${option('false', 'false', value('usePlaywright'))}${option('true', 'true', value('usePlaywright'))}</select></label>
    <label>Playwright Mode<select name="playwrightMode">${option('off', 'off', value('playwrightMode'))}${option('sample', 'sample', value('playwrightMode'))}${option('all', 'all', value('playwrightMode'))}</select></label>
    <label>Template Sampling<select name="enableTemplateSampling">${option('true', 'enabled', value('enableTemplateSampling'))}${option('false', 'disabled', value('enableTemplateSampling'))}</select></label>
    <label>Lighthouse Sampling<select name="enableLighthouseSampling">${option('false', 'disabled', value('enableLighthouseSampling'))}${option('true', 'enabled', value('enableLighthouseSampling'))}</select></label>
    <label>Playwright Sampling<select name="enablePlaywrightSampling">${option('false', 'disabled', value('enablePlaywrightSampling'))}${option('true', 'enabled', value('enablePlaywrightSampling'))}</select></label>
    <label>Samples / Template<input name="sampleUrlsPerTemplate" type="number" min="1" value="${value('sampleUrlsPerTemplate')}"></label>
    <label>Storage Profile<select name="storageProfile">${option('standard', 'standard', value('storageProfile'))}${option('lean', 'lean', value('storageProfile'))}${option('debug', 'debug', value('storageProfile'))}</select><small id="storage-estimate-hint"></small></label>
    <label>Store Raw HTML<select name="storeRawHtml">${option('false', 'false', value('storeRawHtml'))}${option('true', 'true', value('storeRawHtml'))}</select></label>
    <label>Store Rendered HTML<select name="storeRenderedHtml">${option('false', 'false', value('storeRenderedHtml'))}${option('true', 'true', value('storeRenderedHtml'))}</select></label>
    <label>Response Headers<select name="storeResponseHeaders">${option('true', 'compact', value('storeResponseHeaders'))}${option('false', 'off', value('storeResponseHeaders'))}</select></label>
    <label>Store Links<select name="storeAllLinks">${option('true', 'all', value('storeAllLinks'))}${option('false', 'off', value('storeAllLinks'))}</select></label>
    <label>Store Images<select name="storeAllImages">${option('true', 'all', value('storeAllImages'))}${option('false', 'affected only/off', value('storeAllImages'))}</select></label>
    <label>Store Resources<select name="storeAllResources">${option('true', 'all', value('storeAllResources'))}${option('false', 'affected only/off', value('storeAllResources'))}</select></label>
    <label>Affected-only Details<select name="storeAffectedOnlyDetails">${option('false', 'false', value('storeAffectedOnlyDetails'))}${option('true', 'true', value('storeAffectedOnlyDetails'))}</select></label>
    <label>Evidence Samples / Check<input name="maxEvidenceSamplesPerCheck" type="number" min="1" max="100" value="${value('maxEvidenceSamplesPerCheck')}"></label>
    <label>Detail Rows / Check<input name="maxStoredDetailRowsPerCheck" type="number" min="1" max="50000" value="${value('maxStoredDetailRowsPerCheck')}"></label>
    <label>Raw HTML Bytes / URL<input name="maxRawHtmlBytesPerUrl" type="number" min="0" value="${value('maxRawHtmlBytesPerUrl')}"></label>
    <label>LLM Checks<select name="enableLlmChecks">${option('false', 'disabled', value('enableLlmChecks'))}${option('true', 'enabled', value('enableLlmChecks'))}</select><small>Sendet bei externen Providern Seiten-Facts/Inhaltsauszüge an den Provider. Standard aus.</small></label>
    <label>LLM Provider<select name="llmProvider">${option('none', 'none', value('llmProvider'))}${option('openai', 'openai', value('llmProvider'))}${option('anthropic', 'anthropic', value('llmProvider'))}</select></label>
    <label>LLM Model<input name="llmModel" value="${value('llmModel')}"></label>
    <label>LLM Sample URLs<input name="llmMaxSampleUrls" type="number" min="1" max="100" value="${value('llmMaxSampleUrls')}"></label>
    <label>LLM Max Checks<input name="llmMaxChecks" type="number" min="1" max="20" value="${value('llmMaxChecks')}"></label>
    <label>LLM Max Tokens<input name="llmMaxTokens" type="number" min="1000" value="${value('llmMaxTokens')}"></label>
    <label>LLM Dry Run<select name="llmDryRun">${option('true', 'true', value('llmDryRun'))}${option('false', 'false', value('llmDryRun'))}</select></label>
    <label>Request Timeout ms<input name="requestTimeoutMs" type="number" min="1000" value="${value('requestTimeoutMs')}"></label>
    <label>Crawl Delay ms<input name="crawlDelayMs" type="number" min="0" value="${value('crawlDelayMs')}"></label>
  `;
}

function option(value, label, selected) {
  return `<option value="${escapeHtml(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${escapeHtml(label)}</option>`;
}

function largeAuditHint(maxUrls, { inline = false } = {}) {
  const count = Number(maxUrls || 0);
  if (count >= 50000) {
    return `${inline ? ' ' : ''}50.000+ URLs: Crawl/DB möglich, aber Full ZIP/JSON, Reports und Playwright-all können sehr groß/langsam werden.`;
  }
  if (count >= 5000) {
    return `${inline ? ' ' : ''}Großer Audit: Exporte und Rendering-Sampling können deutlich länger dauern.`;
  }
  return '';
}

async function startAudit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.querySelector('#form-message');
  const data = Object.fromEntries(new FormData(form).entries());
  data.maxUrls = Number(data.maxUrls);
  data.maxDepth = Number(data.maxDepth);
  data.concurrency = Number(data.concurrency);
  data.maxConcurrentPerHost = Number(data.maxConcurrentPerHost);
  data.targetPagesPerSecond = Number(data.targetPagesPerSecond || 0);
  data.userAgent = data.userAgent || undefined;
  data.robotsUserAgent = data.robotsUserAgent || undefined;
  data.respectRobotsTxt = data.respectRobotsTxt === 'true';
  data.crawlDelayMs = Number(data.crawlDelayMs);
  data.requestTimeoutMs = Number(data.requestTimeoutMs);
  data.usePlaywright = data.usePlaywright === 'true';
  data.playwrightSampleLimit = Number(data.playwrightSampleLimit);
  data.maxAttempts = Number(data.maxAttempts);
  data.retryBaseDelayMs = Number(data.retryBaseDelayMs);
  data.retryMaxDelayMs = Number(data.retryMaxDelayMs);
  data.maxSitemapUrls = data.maxSitemapUrls === '' ? undefined : Number(data.maxSitemapUrls);
  data.maxSitemaps = Number(data.maxSitemaps);
  data.sitemapBatchSize = Number(data.sitemapBatchSize);
  data.sampleUrlsPerTemplate = Number(data.sampleUrlsPerTemplate);
  data.maxTemplateSamplesTotal = Number(data.maxTemplateSamplesTotal);
  data.enableTemplateSampling = data.enableTemplateSampling !== 'false';
  data.enablePlaywrightSampling = data.enablePlaywrightSampling === 'true';
  data.enableLighthouseSampling = data.enableLighthouseSampling === 'true';
  data.lighthouseDevice = data.lighthouseDevice;
  data.lighthouseCategories = data.lighthouseCategories;
  data.lighthouseTimeoutMs = Number(data.lighthouseTimeoutMs);
  data.playwrightTimeoutMs = Number(data.playwrightTimeoutMs);
  data.collectScreenshots = data.collectScreenshots === 'true';
  data.sampleOnlyIndexable = data.sampleOnlyIndexable !== 'false';
  data.storeRawHtml = data.storeRawHtml === 'true';
  data.storeRenderedHtml = data.storeRenderedHtml === 'true';
  data.storeResponseHeaders = data.storeResponseHeaders !== 'false';
  data.storeAllLinks = data.storeAllLinks !== 'false';
  data.storeAllImages = data.storeAllImages !== 'false';
  data.storeAllResources = data.storeAllResources !== 'false';
  data.storeAffectedOnlyDetails = data.storeAffectedOnlyDetails === 'true';
  data.maxEvidenceSamplesPerCheck = Number(data.maxEvidenceSamplesPerCheck);
  data.maxStoredDetailRowsPerCheck = Number(data.maxStoredDetailRowsPerCheck);
  data.maxRawHtmlBytesPerUrl = Number(data.maxRawHtmlBytesPerUrl);
  data.enableLlmChecks = data.enableLlmChecks === 'true';
  data.llmMaxSampleUrls = Number(data.llmMaxSampleUrls);
  data.llmMaxChecks = Number(data.llmMaxChecks);
  data.llmMaxTokens = Number(data.llmMaxTokens);
  data.llmDryRun = data.llmDryRun !== 'false';
  const fullModeWarning = data.auditMode === 'full' && currentCapabilities?.fullAuditMode?.degraded
    ? ` Full Audit eingeschränkt: ${(currentCapabilities.hints || []).map((item) => `${item.message} (${item.fix})`).join('; ')}`
    : '';
  const debugWarning = data.storageProfile === 'debug' && data.maxUrls > 5000
    ? ' Debug Storage mit mehr als 5.000 URLs kann sehr groß werden.'
    : '';
  const llmWarning = data.enableLlmChecks && data.llmProvider !== 'none'
    ? ' LLM aktiviert: externe Provider erhalten ausgewählte Seiten-Facts/Inhaltsauszüge.'
    : '';
  message.textContent = `Startet...${fullModeWarning}${largeAuditHint(data.maxUrls, { inline: true })}${debugWarning}${llmWarning}`;

  const response = await fetch('/api/audits/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data)
  });
  const payload = await response.json();
  if (!response.ok) {
    message.textContent = payload.error || 'Start fehlgeschlagen';
    return;
  }
  rememberMaturityAutoRedirect(payload.runId);
  window.location.hash = `run/${payload.runId}`;
}

async function startScreamingFrogImport(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.querySelector('#sf-import-message');
  const data = Object.fromEntries(new FormData(form).entries());
  const fileInput = form.querySelector('input[type="file"]');
  const files = [...(fileInput?.files || [])];
  if (!files.length) {
    message.textContent = 'Bitte mindestens eine CSV-Datei wählen.';
    return;
  }
  message.textContent = 'Liest CSV...';
  const payloadFiles = [];
  for (const file of files) {
    payloadFiles.push({ filename: file.name, content: await file.text() });
  }
  message.textContent = 'Importiert...';
  try {
    const payload = await fetchJson('/api/audits/import/screaming-frog', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        domain: data.importDomain || undefined,
        auditType: data.auditType || 'both',
        storageProfile: data.storageProfile || 'standard',
        files: payloadFiles
      })
    });
    message.textContent = `Import abgeschlossen: ${payload.summary?.urlsTotal || 0} URLs.`;
    window.location.hash = `results/${payload.runId}`;
  } catch (error) {
    message.textContent = error.message;
  }
}

async function loadRuns(limit = 10) {
  const container = document.querySelector('#runs');
  const { audits } = await fetchJson('/api/audits');
  if (!audits.length) {
    container.innerHTML = '<div class="empty">Noch keine Runs.</div>';
    return;
  }
  const visibleAudits = audits.slice(0, limit);
  container.innerHTML = visibleAudits.map((run) => `
    <article class="run-card">
      <div>
        <strong>${escapeHtml(run.finalDomain || run.inputDomain)}</strong>
        <div class="muted">Run ${run.id} · ${escapeHtml(run.auditType)} · ${run.processedUrls}/${run.discoveredUrls} URLs</div>
      </div>
      <div class="actions">
        <span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>
        <a class="button" href="#run/${run.id}">Oeffnen</a>
        <button class="danger" data-delete-run="${run.id}" type="button">Loeschen</button>
      </div>
    </article>
  `).join('');
  for (const button of container.querySelectorAll('[data-delete-run]')) {
    button.addEventListener('click', async () => {
      const runId = Number(button.getAttribute('data-delete-run'));
      if (!window.confirm(`Run ${runId} wirklich löschen?`)) return;
      await fetchJson(`/api/audits/${runId}`, { method: 'DELETE' });
      await loadRuns();
    });
  }
}

async function renderSchedules() {
  app.innerHTML = `
    <section class="grid">
      <div class="panel">
        <div class="actions" style="justify-content: space-between;">
          <h2>Monitoring / Schedules</h2>
          <a class="button" href="#">Home</a>
        </div>
        <div id="schedule-dashboard" class="grid metrics"></div>
      </div>
      <form id="schedule-form" class="panel">
        <h2>Schedule anlegen</h2>
        <label>Name
          <input name="name" placeholder="Weekly SEO Monitoring">
        </label>
        <label>Domain
          <input name="domain" placeholder="example.com" required>
        </label>
        <div class="form-row">
          <label>Audit Type
            <select name="auditType">
              <option value="both">Tech + GEO</option>
              <option value="tech">Tech</option>
              <option value="geo">GEO</option>
            </select>
          </label>
          <label>Schedule Type
            <select name="scheduleType">
              <option value="weekly">weekly</option>
              <option value="daily">daily</option>
              <option value="monthly">monthly</option>
              <option value="manual">manual</option>
            </select>
          </label>
        </div>
        <div class="form-row">
          <label>Time
            <input name="timeOfDay" value="09:00" pattern="\\d{1,2}:\\d{2}">
          </label>
          <label>Timezone
            <input name="timezone" value="${escapeHtml(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')}">
          </label>
        </div>
        <div class="form-row">
          <label>Day of Week
            <select name="dayOfWeek">
              <option value="1">Monday</option>
              <option value="2">Tuesday</option>
              <option value="3">Wednesday</option>
              <option value="4">Thursday</option>
              <option value="5">Friday</option>
              <option value="6">Saturday</option>
              <option value="0">Sunday</option>
            </select>
          </label>
          <label>Day of Month
            <input name="dayOfMonth" type="number" min="1" max="31" value="1">
          </label>
        </div>
        <div class="form-row">
          <label>maxUrls
            <input name="maxUrls" type="number" min="1" value="20">
          </label>
          <label>maxDepth
            <input name="maxDepth" type="number" min="0" value="2">
          </label>
        </div>
        <div class="form-row">
          <label>Concurrency
            <input name="concurrency" type="number" min="1" max="10" value="2">
          </label>
          <label>Request Timeout ms
            <input name="requestTimeoutMs" type="number" min="1000" value="15000">
          </label>
        </div>
        <div class="form-row">
          <label>Template Sampling
            <select name="enableTemplateSampling">
              <option value="true">enabled</option>
              <option value="false">disabled</option>
            </select>
          </label>
          <label>Samples / Template
            <input name="sampleUrlsPerTemplate" type="number" min="1" value="5">
          </label>
        </div>
        <div class="form-row">
          <label>Baseline
            <select name="baselineMode">
              <option value="previous_successful">previous_successful</option>
              <option value="fixed_run">fixed_run</option>
              <option value="none">none</option>
            </select>
          </label>
          <label>Fixed Baseline Run
            <input name="baselineRunId" type="number" min="1" placeholder="Optional">
          </label>
        </div>
        <div class="form-row">
          <label>Auto Compare
            <select name="autoCompare">
              <option value="true">enabled</option>
              <option value="false">disabled</option>
            </select>
          </label>
          <label>Active
            <select name="isActive">
              <option value="true">active</option>
              <option value="false">inactive</option>
            </select>
          </label>
        </div>
        <div class="actions">
          <button class="primary" type="submit">Schedule speichern</button>
          <span id="schedule-message" class="muted"></span>
        </div>
      </form>
      <div class="panel">
        <h2>Schedules</h2>
        <div class="table-wrap"><table id="schedules-table"></table></div>
      </div>
    </section>
  `;
  document.querySelector('#schedule-form').addEventListener('submit', createSchedule);
  await loadSchedules();
}

async function createSchedule(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  const payload = {
    name: data.name || undefined,
    domain: data.domain,
    auditType: data.auditType,
    scheduleType: data.scheduleType,
    timeOfDay: data.timeOfDay,
    timezone: data.timezone,
    dayOfWeek: Number(data.dayOfWeek),
    dayOfMonth: Number(data.dayOfMonth),
    maxUrls: Number(data.maxUrls),
    maxDepth: Number(data.maxDepth),
    concurrency: Number(data.concurrency),
    requestTimeoutMs: Number(data.requestTimeoutMs),
    enableTemplateSampling: data.enableTemplateSampling === 'true',
    sampleUrlsPerTemplate: Number(data.sampleUrlsPerTemplate),
    baselineMode: data.baselineMode,
    baselineRunId: data.baselineRunId ? Number(data.baselineRunId) : undefined,
    autoCompare: data.autoCompare === 'true',
    isActive: data.isActive === 'true'
  };
  const message = document.querySelector('#schedule-message');
  message.textContent = 'Speichert...';
  try {
    await fetchJson('/api/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    message.textContent = 'Gespeichert.';
    form.reset();
    await loadSchedules();
  } catch (error) {
    message.textContent = error.message;
  }
}

async function loadSchedules() {
  const { schedules } = await fetchJson('/api/schedules');
  const active = schedules.filter((schedule) => schedule.isActive).length;
  const regressions = schedules.reduce((sum, schedule) => sum + Number(schedule.regressionFindingCount || 0), 0);
  document.querySelector('#schedule-dashboard').innerHTML = `
    ${metric('Schedules', schedules.length)}
    ${metric('Active', active)}
    ${metric('Regressions', regressions)}
    ${metric('Done Runs', schedules.reduce((sum, schedule) => sum + Number(schedule.completedRuns || 0), 0))}
  `;
  const table = document.querySelector('#schedules-table');
  if (!schedules.length) {
    table.innerHTML = '<tbody><tr><td class="muted">Noch keine Schedules.</td></tr></tbody>';
    return;
  }
  table.innerHTML = `
    <thead><tr>
      <th>Name</th><th>Domain</th><th>Schedule</th><th>Next Run</th><th>Last Run</th>
      <th>Score</th><th>Delta</th><th>Regressions</th><th>Resolved</th><th>Status</th><th>Aktionen</th>
    </tr></thead>
    <tbody>
      ${schedules.map((schedule) => scheduleRow(schedule)).join('')}
    </tbody>
  `;
  for (const button of table.querySelectorAll('[data-run-schedule]')) {
    button.addEventListener('click', async () => {
      const id = Number(button.getAttribute('data-run-schedule'));
      button.disabled = true;
      button.textContent = 'Startet...';
      try {
        const result = await fetchJson(`/api/schedules/${id}/run-now`, { method: 'POST' });
        if (result.runId) window.location.hash = `run/${result.runId}`;
        else await loadSchedules();
      } catch (error) {
        window.alert(error.message);
        await loadSchedules();
      }
    });
  }
  for (const button of table.querySelectorAll('[data-toggle-schedule]')) {
    button.addEventListener('click', async () => {
      const id = Number(button.getAttribute('data-toggle-schedule'));
      const action = button.getAttribute('data-toggle-action');
      await fetchJson(`/api/schedules/${id}/${action}`, { method: 'POST' });
      await loadSchedules();
    });
  }
  for (const button of table.querySelectorAll('[data-delete-schedule]')) {
    button.addEventListener('click', async () => {
      const id = Number(button.getAttribute('data-delete-schedule'));
      if (!window.confirm(`Schedule ${id} wirklich löschen? Alte Runs bleiben erhalten.`)) return;
      await fetchJson(`/api/schedules/${id}`, { method: 'DELETE' });
      await loadSchedules();
    });
  }
}

function scheduleRow(schedule) {
  const lastRun = schedule.lastRun;
  const comparison = schedule.latestComparison;
  const links = comparison ? comparisonLinks({ comparisonId: comparison.id }) : null;
  return `<tr>
    <td>${escapeHtml(schedule.name || `Schedule ${schedule.id}`)}<div class="muted">#${schedule.id} · ${escapeHtml(schedule.baselineMode || 'none')}</div></td>
    <td>${escapeHtml(schedule.domain)}</td>
    <td>${escapeHtml(schedule.scheduleType)}<div class="muted">${escapeHtml(schedule.timeOfDay || '')} ${escapeHtml(schedule.timezone || '')}</div></td>
    <td>${escapeHtml(schedule.nextRunAt || 'manual')}</td>
    <td>${lastRun ? `<a href="#run/${lastRun.id}">Run ${lastRun.id}</a><div class="muted">${escapeHtml(lastRun.status)}</div>` : '<span class="muted">none</span>'}</td>
    <td>${scoreLabel(schedule.lastScore)}</td>
    <td>${escapeHtml(formatSigned(schedule.scoreDelta))}</td>
    <td>${schedule.regressionFindingCount || 0}</td>
    <td>${schedule.resolvedCount || 0}</td>
    <td>${schedule.isActive ? 'active' : 'inactive'}${schedule.lastError ? `<div class="muted">${escapeHtml(schedule.lastError)}</div>` : ''}</td>
    <td>
      <div class="actions">
        <button data-run-schedule="${schedule.id}" type="button">Run now</button>
        <button data-toggle-schedule="${schedule.id}" data-toggle-action="${schedule.isActive ? 'disable' : 'enable'}" type="button">${schedule.isActive ? 'Disable' : 'Enable'}</button>
        ${lastRun ? `<a class="button" href="#run/${lastRun.id}">Run</a>` : ''}
        ${links ? `<a class="button" href="${links.report}" target="_blank" rel="noreferrer">Comparison</a><a class="button" href="${links.findings}">Delta CSV</a>` : ''}
        <button class="danger" data-delete-schedule="${schedule.id}" type="button">Loeschen</button>
      </div>
    </td>
  </tr>`;
}

async function renderRun(runId) {
  app.innerHTML = `
    <section class="grid">
      <div class="panel">
        <div class="actions" style="justify-content: space-between;">
          <h2 id="run-title">Run ${runId}</h2>
          <div class="actions">
            <button id="pause-btn">Pausieren</button>
            <button id="resume-btn">Fortsetzen</button>
            <button id="recover-btn">Recover</button>
            <button id="cancel-btn" class="danger">Abbrechen</button>
            <button id="delete-btn" class="danger">Loeschen</button>
            <a class="button" href="#results/${runId}">Results</a>
            <a class="button" href="#maturity/${runId}">Reifegrad</a>
            <a class="button primary" href="/api/audits/${runId}/report" target="_blank" rel="noreferrer">Report</a>
          </div>
        </div>
        <div class="progress" aria-label="Crawl progress"><span id="progress-bar"></span></div>
        <div id="metrics" class="grid metrics" style="margin-top: 14px;"></div>
      </div>
      <div class="panel">
        <h2>Exports</h2>
        ${exportLinks(runId)}
      </div>
      <div class="panel">
        <h2>Run Comparison</h2>
        <div id="comparison-panel" class="comparison-panel">
          <div class="muted">Lädt Vergleichskandidaten...</div>
        </div>
      </div>
      <div class="panel">
        <h2>Logs</h2>
        <div id="logs" class="log"></div>
      </div>
    </section>
  `;

  document.querySelector('#pause-btn').addEventListener('click', () => postRunAction(runId, 'pause'));
  document.querySelector('#resume-btn').addEventListener('click', () => postRunAction(runId, 'resume'));
  document.querySelector('#recover-btn').addEventListener('click', () => postRunAction(runId, 'recover'));
  document.querySelector('#cancel-btn').addEventListener('click', () => postRunAction(runId, 'cancel'));
  document.querySelector('#delete-btn').addEventListener('click', async () => {
    if (!window.confirm(`Run ${runId} wirklich löschen?`)) return;
    await fetchJson(`/api/audits/${runId}`, { method: 'DELETE' });
    window.location.hash = '';
  });
  await renderComparisonPanel(runId);

  const refresh = async () => {
    const run = await fetchJson(`/api/audits/${runId}`);
    updateRunView(run);
    if (run.status === 'completed' && shouldAutoRedirectToMaturity(runId)) {
      clearMaturityAutoRedirect();
      window.location.hash = `maturity/${runId}`;
      return;
    }
    if (['failed', 'cancelled'].includes(run.status)) {
      clearMaturityAutoRedirect();
    }
    if (!['completed', 'failed', 'cancelled'].includes(run.status)) {
      pollTimer = setTimeout(refresh, 2000);
    }
  };
  await refresh();
}

function shouldAutoRedirectToMaturity(runId) {
  const storage = safeSessionStorage();
  const storedRunId = storage?.getItem('maturityAutoRedirectRunId') || pendingMaturityAutoRedirectRunId;
  return storedRunId === String(runId) &&
    !window.location.hash.startsWith('#results/');
}

function rememberMaturityAutoRedirect(runId) {
  pendingMaturityAutoRedirectRunId = String(runId);
  const storage = safeSessionStorage();
  if (!storage) return;
  storage.setItem('maturityAutoRedirectRunId', String(runId));
}

function clearMaturityAutoRedirect() {
  pendingMaturityAutoRedirectRunId = null;
  const storage = safeSessionStorage();
  if (!storage) return;
  storage.removeItem('maturityAutoRedirectRunId');
}

function safeSessionStorage() {
  try {
    return window.sessionStorage || null;
  } catch {
    return null;
  }
}

async function renderComparisonPanel(runId) {
  const container = document.querySelector('#comparison-panel');
  if (!container) return;
  try {
    const [candidatePayload, savedPayload] = await Promise.all([
      fetchJson(`/api/audits/${runId}/comparison-candidates`),
      fetchJson(`/api/audits/${runId}/comparisons`)
    ]);
    const candidates = candidatePayload.candidates || [];
    const savedComparisons = savedPayload.comparisons || [];
    container.innerHTML = `
      <div class="actions">
        <label>Base Run
          <select id="comparison-candidate" ${candidates.length ? '' : 'disabled'}>
            ${candidates.map((candidate) => `<option value="${candidate.runId}">
              Run ${candidate.runId} · ${escapeHtml(candidate.finishedAt || candidate.updatedAt || '')} · Score ${scoreLabel(candidate.overallScore)}
            </option>`).join('')}
          </select>
        </label>
        <button id="compare-run-btn" type="button" ${candidates.length ? '' : 'disabled'}>Vergleichen</button>
        <span id="comparison-message" class="muted">${candidates.length ? '' : 'Keine abgeschlossenen Vergleichskandidaten für diese Domain.'}</span>
      </div>
      <div id="saved-comparisons" style="margin-top: 12px;">
        ${savedComparisonLinks(savedComparisons)}
      </div>
      <div id="comparison-result" style="margin-top: 12px;"></div>
    `;
    const button = container.querySelector('#compare-run-btn');
    button?.addEventListener('click', async () => {
      const baseRunId = Number(container.querySelector('#comparison-candidate').value);
      const message = container.querySelector('#comparison-message');
      message.textContent = 'Vergleicht...';
      button.disabled = true;
      try {
        const comparison = await fetchJson('/api/audits/compare', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ baseRunId, compareRunId: runId, save: true })
        });
        message.textContent = comparison.status === 'not_comparable' ? 'Nicht vergleichbar.' : 'Vergleich gespeichert.';
        renderComparisonResult(container.querySelector('#comparison-result'), comparison);
      } catch (error) {
        message.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  } catch (error) {
    container.innerHTML = `<div class="muted">Comparison konnte nicht geladen werden: ${escapeHtml(error.message)}</div>`;
  }
}

function renderComparisonResult(container, comparison) {
  if (!container) return;
  const summary = comparison.summary || {};
  const links = comparisonLinks(comparison);
  container.innerHTML = `
    <div class="grid metrics">
      ${metric('Status', escapeHtml(comparison.status || 'completed'))}
      ${metric('Overall Delta', escapeHtml(formatSigned(summary.overallScoreDelta)))}
      ${metric('Tech Delta', escapeHtml(formatSigned(summary.techScoreDelta)))}
      ${metric('GEO Delta', escapeHtml(formatSigned(summary.geoScoreDelta)))}
      ${metric('New Issues', (summary.findingDeltaCounts?.new || 0))}
      ${metric('Resolved', (summary.findingDeltaCounts?.resolved || 0))}
      ${metric('Worsened', (summary.findingDeltaCounts?.worsened || 0))}
      ${metric('Regressions', summary.regressionFindingCount || 0)}
    </div>
    ${comparison.comparisonWarning ? `<p class="muted">${escapeHtml(comparison.comparisonWarning)}</p>` : ''}
    <div class="actions" style="margin-top: 10px;">
      <a class="button primary" href="${links.report}" target="_blank" rel="noreferrer">Comparison Report</a>
      <a class="button" href="${links.findings}">Findings Delta CSV</a>
      <a class="button" href="${links.urls}">URL Delta CSV</a>
      <a class="button" href="${links.templates}">Template Delta CSV</a>
      <a class="button" href="${links.performance}">Performance Delta CSV</a>
    </div>
    <h3>Finding Deltas</h3>
    ${compactDeltaTable((comparison.findingsDelta || []).filter((row) => row.deltaType !== 'unchanged_ok').slice(0, 25), [
      ['checkId', 'Check'],
      ['deltaType', 'Delta'],
      ['baseStatus', 'Base'],
      ['compareStatus', 'Compare'],
      ['basePriority', 'Base Prio'],
      ['comparePriority', 'Compare Prio'],
      ['affectedDelta', 'Affected'],
      ['compareFinding', 'Finding']
    ])}
    <h3>URL Deltas</h3>
    ${compactDeltaTable((comparison.urlDelta || []).filter((row) => row.deltaType !== 'unchangedUrl').slice(0, 25), [
      ['url', 'URL'],
      ['deltaType', 'Delta'],
      ['baseStatusCode', 'Base'],
      ['compareStatusCode', 'Compare'],
      ['baseIndexable', 'Base Indexable'],
      ['compareIndexable', 'Compare Indexable']
    ])}
    <h3>Template / Performance Deltas</h3>
    ${compactDeltaTable([...(comparison.templateDelta || []), ...(comparison.performanceDelta || [])].filter((row) =>
      !['unchangedTemplate', 'notComparable'].includes(row.deltaType)
    ).slice(0, 25), [
      ['templateClusterKey', 'Template'],
      ['deltaType', 'Delta'],
      ['urlCountDelta', 'URL Delta'],
      ['performanceScoreDelta', 'Perf Delta'],
      ['lcpDeltaMs', 'LCP Delta']
    ])}
  `;
}

function savedComparisonLinks(comparisons) {
  if (!comparisons.length) return '<div class="muted">Noch keine gespeicherten Vergleiche für diesen Run.</div>';
  return `
    <h3>Gespeicherte Vergleiche</h3>
    <div class="actions">
      ${comparisons.slice(0, 8).map((comparison) => `
        <a class="button" href="/api/audits/comparisons/${comparison.id}/report" target="_blank" rel="noreferrer">
          #${comparison.id}: ${comparison.baseRunId} vs ${comparison.compareRunId}
        </a>
      `).join('')}
    </div>
  `;
}

function comparisonLinks(comparison) {
  if (comparison.comparisonId) {
    const base = `/api/audits/comparisons/${comparison.comparisonId}`;
    return {
      report: `${base}/report`,
      findings: `${base}/export/findings-delta.csv`,
      urls: `${base}/export/url-delta.csv`,
      templates: `${base}/export/template-delta.csv`,
      performance: `${base}/export/performance-delta.csv`
    };
  }
  const query = `baseRunId=${encodeURIComponent(comparison.baseRunId)}&compareRunId=${encodeURIComponent(comparison.compareRunId)}`;
  return {
    report: `/api/audits/compare/report?${query}`,
    findings: `/api/audits/compare/export/findings-delta.csv?${query}`,
    urls: `/api/audits/compare/export/url-delta.csv?${query}`,
    templates: `/api/audits/compare/export/template-delta.csv?${query}`,
    performance: `/api/audits/compare/export/performance-delta.csv?${query}`
  };
}

function compactDeltaTable(rows, columns) {
  if (!rows.length) return '<div class="muted">Keine Deltas.</div>';
  return `
    <div class="table-wrap"><table>
      <thead><tr>${columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows.map((row) => `<tr>${columns.map(([key]) => `<td>${escapeHtml(formatCell(row[key]))}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table></div>
  `;
}

function updateRunView(run) {
  document.querySelector('#run-title').textContent = `${run.finalDomain || run.inputDomain} · Run ${run.id}`;
  const progress = run.discoveredUrls ? Math.round((run.processedUrls / run.discoveredUrls) * 100) : 0;
  const health = run.health || run.healthStatus || 'unknown';
  const recoverButton = document.querySelector('#recover-btn');
  if (recoverButton) {
    const oldProcessing = Number(run.oldestProcessingAgeSeconds || 0) > 120;
    recoverButton.disabled = !(health === 'stale' || oldProcessing);
  }
  document.querySelector('#progress-bar').style.width = `${Math.min(100, progress)}%`;
  document.querySelector('#metrics').innerHTML = `
    ${metric('Status', `<span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span>`)}
    ${metric('Health', `<span class="status ${escapeHtml(health)}">${escapeHtml(health)}</span>`)}
    ${metric('Phase', escapeHtml(run.currentPhase))}
    ${metric('Trigger', escapeHtml(run.triggerType || 'manual'))}
    ${metric('Schedule', run.scheduledRunId ? `<a href="#schedules">${escapeHtml(run.scheduleName || `Schedule ${run.scheduledRunId}`)}</a>` : 'manual')}
    ${metric('Baseline', run.baselineRunId ? `<a href="#run/${run.baselineRunId}">Run ${run.baselineRunId}</a>` : 'none')}
    ${metric('Auto Comparison', run.comparisonId ? `<a href="/api/audits/comparisons/${run.comparisonId}/report" target="_blank" rel="noreferrer">#${run.comparisonId}</a>` : 'none')}
    ${metric('Regressions', run.autoComparison?.regressionFindings?.length ?? 0)}
    ${metric('Processed', `${run.processedUrls}/${run.discoveredUrls}`)}
    ${metric('Queued', run.queuedUrls)}
    ${metric('Waiting', run.waitingUrls ?? 0)}
    ${metric('Workers', run.workerCount ?? 0)}
    ${metric('Successful', run.successfulUrls)}
    ${metric('Failed', run.failedUrls)}
    ${metric('Retryable Failures', run.retryableFailures ?? 0)}
    ${metric('Permanent Failures', run.permanentFailures ?? 0)}
    ${metric('Sitemap Files', run.sitemapFilesProcessed ?? 0)}
    ${metric('Sitemap URLs', `${run.sitemapUrlsQueued ?? 0}/${run.sitemapUrlsDiscovered ?? 0}`)}
    ${metric('Samples', `${run.samplesProcessed ?? 0}/${run.samplesTotal ?? 0}`)}
    ${metric('Current Sample', escapeHtml(run.currentSampleUrl || ''))}
    ${metric('Skipped', run.skippedUrls)}
    ${metric('Pages/min', run.pagesPerMinute)}
    ${metric('Review Progress', escapeHtml(run.reviewProgress || '0/0'))}
    ${metric('Needs Fix', run.reviewNeedsFix ?? 0)}
    ${metric('False Positives', run.reviewFalsePositive ?? 0)}
    ${metric('Review Done', run.reviewDone ?? 0)}
    ${metric('Elapsed', formatSeconds(run.elapsedTime))}
    ${metric('ETA', run.estimatedRemainingTime === null ? 'NA' : formatSeconds(run.estimatedRemainingTime))}
    ${metric('Heartbeat', escapeHtml(run.heartbeatAt || ''))}
    ${metric('Oldest Processing', run.oldestProcessingAgeSeconds === null ? 'NA' : formatSeconds(run.oldestProcessingAgeSeconds))}
    ${metric('Current Sitemap', escapeHtml(run.currentSitemapUrl || ''))}
    ${metric('Current URL', escapeHtml(run.currentUrl || ''))}
  `;

  document.querySelector('#logs').innerHTML = (run.latestLogMessages || []).map((log) => `
    <div class="log-line">[${escapeHtml(log.level)}] ${escapeHtml(log.createdAt)} ${escapeHtml(log.message)}</div>
  `).join('');
}

async function postRunAction(runId, action) {
  clearPoll();
  await fetchJson(`/api/audits/${runId}/${action}`, { method: 'POST' });
  await renderRun(runId);
}

async function renderResults(runId, options = {}) {
  currentRunId = runId;
  selectedFindings = new Set();
  resultsState = {
    status: '',
    priority: '',
    findingType: '',
    confidence: '',
    reviewRecommended: '',
    reviewStatus: '',
    actionStatus: '',
    category: '',
    needsReview: false,
    quickFilter: '',
    search: '',
    sort: 'recommended',
    page: 1
  };
  app.innerHTML = `
    <section class="grid">
      <div class="panel">
        <div class="actions" style="justify-content: space-between;">
          <h2 id="results-title">Audit Workspace · Run ${runId}</h2>
          <div class="actions">
            <a class="button" href="#maturity/${runId}">Reifegrad ansehen</a>
            <a class="button" href="#validation/${runId}">Enterprise Validation</a>
            <a class="button primary" data-export-download href="/api/audits/${runId}/export/full.zip" download="audit-${runId}-full-audit.zip">Full Audit Export ZIP</a>
            <a class="button" data-export-download href="/api/audits/${runId}/export/full.json" download="audit-${runId}-full-audit.json">Full Audit JSON</a>
          </div>
        </div>
        <div id="results-run-context" class="run-context muted"></div>
        <div id="export-message" class="muted"></div>
        <div id="scores" class="grid metrics"></div>
        <details class="reports-history secondary-workspace-detail">
          <summary>Reports & Verlauf</summary>
          <div class="actions">
            <a class="button" href="#run/${runId}">Technischer Run-Status</a>
            <a class="button" href="/api/audits/${runId}/report" target="_blank" rel="noreferrer">HTML Report</a>
          </div>
        </details>
        <details class="secondary-exports secondary-workspace-detail">
          <summary>Weitere CSV-Exports</summary>
          <p class="muted">Einzelne CSV-Dateien bleiben für Spezialfälle verfügbar.</p>
          ${exportLinks(runId)}
        </details>
      </div>
      <div class="panel">
        <div class="filters card-filters">
          <button class="quick-filter active" data-quick-filter="" type="button">Alle</button>
          <button class="quick-filter" data-quick-filter="todo" type="button">ToDo</button>
          <button class="quick-filter" data-quick-filter="warning" type="button">Warnings</button>
          <button class="quick-filter" data-quick-filter="opportunities" type="button">Opportunities</button>
          <button class="quick-filter" data-quick-filter="passed" type="button">OK</button>
          <button class="quick-filter" data-quick-filter="na" type="button">N/A</button>
          <input id="filter-search" class="filter-search" placeholder="Check ID, Text oder URL suchen">
          <select id="filter-sort">
            <option value="recommended">Empfohlene Reihenfolge</option>
            <option value="priority">Priorität</option>
            <option value="status">Status</option>
            <option value="category">Kategorie</option>
          </select>
          <details class="advanced-filter-detail">
            <summary>Filter erweitern</summary>
            <div class="filters">
              <select id="filter-status"><option value="">Alle Status</option></select>
              <select id="filter-priority"><option value="">Alle Prioritäten</option></select>
              <select id="filter-finding-type"><option value="">Alle Finding Types</option></select>
              <select id="filter-confidence"><option value="">Alle Confidence</option></select>
              <select id="filter-review-recommended">
                <option value="">Review Recommended</option>
                <option value="yes">ja</option>
                <option value="no">nein</option>
              </select>
              <select id="filter-review-status"><option value="">Alle Review Status</option></select>
              <select id="filter-action-status"><option value="">Alle Action Status</option></select>
              <select id="filter-category"><option value="">Alle Kategorien</option></select>
            </div>
          </details>
        </div>
      </div>
      <div id="findings" class="check-card-list"></div>
      <details class="panel technical-details">
        <summary>Technische Details</summary>
        <section>
          <h2>Review Workflow</h2>
          <div id="review-summary" class="grid metrics"></div>
          <div class="actions" style="margin-top: 12px;">
            <button id="needs-review-filter" type="button">Needs Review</button>
            <button id="clear-review-filter" type="button">Filter zurücksetzen</button>
          </div>
        </section>
        <section id="bulk-section" hidden>
          <h2>Bulk</h2>
          <div class="actions">
            <select id="bulk-review-status">
              <option value="">Review Status</option>
              <option value="confirmed">confirmed</option>
              <option value="false_positive">false_positive</option>
              <option value="needs_fix">needs_fix</option>
              <option value="ignored">ignored</option>
            </select>
            <select id="bulk-action-status">
              <option value="">Action Status</option>
              <option value="planned">planned</option>
              <option value="in_progress">in_progress</option>
              <option value="done">done</option>
              <option value="wont_do">wont_do</option>
            </select>
            <select id="bulk-manual-priority">
              <option value="">Manual Priority</option>
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Low">Low</option>
            </select>
            <input id="bulk-note" placeholder="Notiz für Bulk-Update">
            <button id="bulk-apply" type="button">Bulk setzen</button>
            <span id="bulk-count" class="muted">0 ausgewählt</span>
          </div>
        </section>
        <section>
          <h2>Sampling Summary</h2>
          <div id="sampling-summary" class="grid metrics"></div>
          <p id="sampling-note" class="muted"></p>
        </section>
        <section>
          <h2>Templates / URL-Cluster</h2>
          <div class="table-wrap"><table id="templates"></table></div>
        </section>
        <section>
          <h2>Template Performance</h2>
          <div class="table-wrap"><table id="template-performance"></table></div>
        </section>
        <section>
          <div class="actions" style="justify-content: space-between;">
            <h2>URL-Inventar</h2>
            <div class="actions">
              <button id="prev-page">Zurück</button>
              <span id="page-label" class="muted"></span>
              <button id="next-page">Weiter</button>
            </div>
          </div>
          <div class="table-wrap"><table id="pages"></table></div>
        </section>
      </details>
    </section>
    <div id="review-modal" class="modal" hidden>
      <div class="modal-card">
        <div class="actions" style="justify-content: space-between;">
          <h2 id="review-modal-title">Finding Review</h2>
          <button id="review-close" type="button">Schließen</button>
        </div>
        <input id="review-check-result-id" type="hidden">
        <div class="review-grid">
          <section>
            <h3>Überblick</h3>
            <div id="check-detail-narrative" class="detail-narrative"></div>
            <div class="actions detail-actions">
              <a id="check-detail-export" class="button" href="#">Prüfpunkt exportieren</a>
            </div>
            <h3>Betroffene URLs / Daten</h3>
            <div id="check-detail-table" class="detail-table"></div>
            <details class="detail-technical">
              <summary>Originalwerte</summary>
              <dl id="review-original" class="kv"></dl>
            </details>
            <details class="detail-technical">
              <summary>Evidence</summary>
              <pre id="review-evidence" class="evidence"></pre>
            </details>
          </section>
          <form id="review-form">
            <h3>Review</h3>
            <div class="form-row">
              <label>Review Status
                <select id="review-status">
                  <option value="unreviewed">unreviewed</option>
                  <option value="confirmed">confirmed</option>
                  <option value="false_positive">false_positive</option>
                  <option value="accepted_risk">accepted_risk</option>
                  <option value="needs_fix">needs_fix</option>
                  <option value="fixed">fixed</option>
                  <option value="ignored">ignored</option>
                </select>
              </label>
              <label>Action Status
                <select id="review-action-status">
                  <option value="open">open</option>
                  <option value="planned">planned</option>
                  <option value="in_progress">in_progress</option>
                  <option value="done">done</option>
                  <option value="wont_do">wont_do</option>
                </select>
              </label>
            </div>
            <div class="form-row">
              <label>Manual Status
                <select id="review-manual-status">
                  <option value="">Original behalten</option>
                  <option value="OK">OK</option>
                  <option value="Warning">Warning</option>
                  <option value="Error">Error</option>
                  <option value="NA">NA</option>
                </select>
              </label>
              <label>Manual Priority
                <select id="review-manual-priority">
                  <option value="">Original behalten</option>
                  <option value="High">High</option>
                  <option value="Medium">Medium</option>
                  <option value="Low">Low</option>
                </select>
              </label>
            </div>
            <label>Manual Effort
              <select id="review-manual-effort">
                <option value="">Original behalten</option>
                <option value="S">S</option>
                <option value="M">M</option>
                <option value="L">L</option>
              </select>
            </label>
            <label>Manual Finding
              <textarea id="review-manual-finding" rows="3"></textarea>
            </label>
            <label>Manual Recommendation
              <textarea id="review-manual-recommendation" rows="3"></textarea>
            </label>
            <label>Notiz
              <textarea id="review-note" rows="3"></textarea>
            </label>
            <label>Reviewer Name
              <input id="reviewer-name">
            </label>
            <div class="actions">
              <button class="primary" type="submit">Speichern</button>
              <button id="review-delete" class="danger" type="button">Review löschen</button>
              <span id="review-message" class="muted"></span>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;

  const [payload, maturityPayload] = await Promise.all([
    fetchJson(`/api/audits/${runId}/results`),
    fetchJson(`/api/audits/${runId}/maturity`).catch(() => null)
  ]);
  setCurrentMaturityIndex(maturityPayload);
  setCurrentResults(payload.results);
  renderResultsRunContext(payload.run);
  renderScoreCards(payload.scores, payload.run, payload.samplingSummary);
  renderReviewSummary(payload.reviewSummary);
  renderSamplingSummary(payload.samplingSummary);
  setupFilters(payload.results, runId);
  setupBulkActions(runId);
  setupReviewModal(runId);
  setupExportDownloads();
  await renderTemplates(runId);
  await renderTemplatePerformance(runId);
  renderFindings(payload.results);
  await renderPages(runId);
  if (options.openCheckResultId) {
    focusFindingCard(options.openCheckResultId);
    await openReviewModal(options.openCheckResultId);
  }
}

async function renderMaturity(runId) {
  app.innerHTML = `
    <section class="maturity-page">
      <div class="panel maturity-loading">
        <div class="eyebrow">GEO Visibility Reifegrad</div>
        <h2>Reifegrad wird geladen...</h2>
        <p class="muted">Die Ansicht wird aus den vorhandenen Audit-Ergebnissen berechnet.</p>
      </div>
    </section>
  `;
  try {
    currentRunId = runId;
    const [maturity, resultsPayload] = await Promise.all([
      fetchJson(`/api/audits/${runId}/maturity`),
      fetchJson(`/api/audits/${runId}/results`).catch(() => ({ results: [] }))
    ]);
    setCurrentMaturityIndex(maturity);
    setCurrentResults(resultsPayload.results || []);
    renderMaturityPage(maturity);
    setupMaturitySunburstTooltip();
    setupExportDownloads();
  } catch (error) {
    app.innerHTML = `
      <section class="maturity-page">
        <div class="panel">
          <div class="eyebrow">GEO Visibility Reifegrad</div>
          <h2>Reifegrad nicht verfügbar</h2>
          <p class="muted">${escapeHtml(error.message)}</p>
          <div class="actions">
            <a class="button" href="#run/${runId}">Zum Run</a>
            <a class="button" href="#results/${runId}">Zum Audit Workspace</a>
          </div>
        </div>
      </section>
    `;
  }
}

async function renderValidation(runId) {
  currentRunId = runId;
  app.innerHTML = `
    <section class="validation-page">
      <section class="panel">
        <div class="actions" style="justify-content: space-between;">
          <div>
            <div class="eyebrow">Enterprise Validation</div>
            <h2>Manual Audit Vergleich · Run ${runId}</h2>
            <p class="muted">CSV oder JSON Reference Audit hochladen und gegen die Tool-Findings vergleichen.</p>
          </div>
          <div class="actions">
            <a class="button" href="#results/${runId}">Audit Workspace</a>
            <a class="button" href="#maturity/${runId}">Reifegrad</a>
          </div>
        </div>
        <form id="validation-form" class="validation-upload">
          <label>Reference Audit CSV/JSON
            <input name="reference" type="file" accept=".csv,.json,text/csv,application/json" required>
          </label>
          <div class="actions">
            <button class="primary" type="submit">Validation starten</button>
            <span id="validation-message" class="muted"></span>
          </div>
        </form>
      </section>
      <section id="validation-report-panel" class="panel">
        <div class="empty">Noch kein Validation Report geladen.</div>
      </section>
    </section>
  `;
  document.querySelector('#validation-form').addEventListener('submit', (event) => startValidationUpload(event, runId));
  try {
    const report = await fetchJson(`/api/audits/${runId}/validation`);
    renderValidationReport(report);
  } catch {
    // A run can exist before a reference audit has been validated.
  }
}

async function startValidationUpload(event, runId) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.querySelector('#validation-message');
  const file = form.querySelector('input[type="file"]')?.files?.[0];
  if (!file) {
    message.textContent = 'Bitte CSV oder JSON wählen.';
    return;
  }
  message.textContent = 'Liest Reference Audit...';
  try {
    const content = await file.text();
    message.textContent = 'Vergleicht gegen Tool-Findings...';
    const report = await fetchJson(`/api/audits/${runId}/validation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        referenceFile: {
          filename: file.name,
          content
        }
      })
    });
    message.textContent = `Validation fertig: ${report.validationSummary?.coveragePercent ?? 0}% Coverage.`;
    renderValidationReport(report);
  } catch (error) {
    message.textContent = error.message;
  }
}

function renderValidationReport(report) {
  const panel = document.querySelector('#validation-report-panel');
  if (!panel) return;
  const summary = report.validationSummary || {};
  panel.innerHTML = `
    <div class="actions" style="justify-content: space-between;">
      <h3>Coverage Summary</h3>
      <div class="actions validation-export-links">
        <a class="button" href="/api/audits/${report.runId}/validation/export/executive-validation-summary.md">Executive</a>
        <a class="button" href="/api/audits/${report.runId}/validation/export/validation-report.html">HTML</a>
        <a class="button" href="/api/audits/${report.runId}/validation/export/validation-report.md">MD</a>
        <a class="button" href="/api/audits/${report.runId}/validation/export/coverage-matrix.csv">Matrix CSV</a>
        <a class="button" href="/api/audits/${report.runId}/validation/export/coverage-matrix.json">Matrix JSON</a>
        <a class="button" href="/api/audits/${report.runId}/validation/export/partial-coverage-diagnostics.md">Partial Diagnostics</a>
        <a class="button" href="/api/audits/${report.runId}/validation/export/false-negatives.md">False Negatives</a>
        <a class="button" href="/api/audits/${report.runId}/validation/export/false-positives.md">False Positives</a>
        <a class="button" href="/api/audits/${report.runId}/validation/export/tool-gap-backlog.md">Backlog</a>
        <a class="button" href="/api/audits/${report.runId}/validation/export/check-roadmap.md">Roadmap</a>
        <a class="button" href="/api/audits/${report.runId}/validation/export/storage-reality-check.md">Storage</a>
      </div>
    </div>
    <div class="grid metrics validation-metrics">
      ${metric('Manual Items', summary.manualItemCount || 0)}
      ${metric('Covered', summary.covered || 0)}
      ${metric('Covered Sample', summary.coveredInSample || 0)}
      ${metric('Partial', summary.partiallyCovered || 0)}
      ${metric('Not Covered', (summary.notCovered || 0) + (summary.falseNegativeCandidates || 0))}
      ${metric('External Data', summary.needsExternalData || 0)}
      ${metric('Larger Crawl', summary.needsLargerCrawl || 0)}
      ${metric('Human Review', summary.needsHumanReview || 0)}
      ${metric('LLM Review', summary.needsLlmReview || 0)}
      ${metric('Partial Sample', summary.partialLimitations?.needsLargerCrawl || 0)}
      ${metric('Partial Data', summary.partialLimitations?.needsExternalData || 0)}
      ${metric('Partial Review', summary.partialLimitations?.needsHumanReview || 0)}
      ${metric('Tool Extras', summary.toolExtras || 0)}
      ${metric('False Positives', summary.falsePositiveCandidates || 0)}
      ${score('Coverage', summary.coveragePercent ?? 0)}
    </div>
    <div class="validation-filters actions">
      ${validationFilterButton('', 'Alle')}
      ${validationFilterButton('covered', 'Covered')}
      ${validationFilterButton('covered_in_sample', 'Covered Sample')}
      ${validationFilterButton('partially_covered', 'Partial')}
      ${validationFilterButton('partial:sample_too_small', 'Partial: Sample')}
      ${validationFilterButton('partial:evidence_too_weak', 'Partial: Evidence')}
      ${validationFilterButton('partial:human_review_needed', 'Partial: Human')}
      ${validationFilterButton('partial:missing_data_source', 'Partial: Data')}
      ${validationFilterButton('partial:already_covered_but_mapping_too_strict', 'Partial: Mapping')}
      ${validationFilterButton('upgrade:eligible', 'Upgrade eligible')}
      ${validationFilterButton('false_negative_candidate', 'False Negatives')}
      ${validationFilterButton('needs_external_data', 'External Data')}
      ${validationFilterButton('needs_larger_crawl', 'Larger Crawl')}
      ${validationFilterButton('needs_human_review', 'Human Review')}
      ${validationFilterButton('needs_llm_review', 'LLM Review')}
      ${validationFilterButton('tool_finds_extra', 'Tool Extras')}
      ${validationFilterButton('extra:false_positive_candidate', 'False Positives')}
    </div>
    <div class="table-scroll">
      <table class="validation-matrix">
        <thead>
          <tr><th>Manual Item</th><th>Status</th><th>Confidence</th><th>Matched Checks</th><th>Partial Reason</th><th>Match Reasons</th><th>Missing Reasons</th><th>Rationale</th></tr>
        </thead>
        <tbody id="validation-matrix-body"></tbody>
      </table>
    </div>
  `;
  panel.dataset.validationReport = JSON.stringify(report);
  for (const button of panel.querySelectorAll('[data-validation-filter]')) {
    button.addEventListener('click', () => {
      panel.querySelectorAll('[data-validation-filter]').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      renderValidationRows(report, button.getAttribute('data-validation-filter'));
    });
  }
  renderValidationRows(report, '');
}

function renderValidationRows(report, filter) {
  const body = document.querySelector('#validation-matrix-body');
  if (!body) return;
  const manualRows = report.coverageMatrix || [];
  const extraRows = (report.unmatchedToolFindings || []).map((row) => ({
    coverageStatus: 'tool_finds_extra',
    extraClassification: row.extraClassification,
    confidence: row.confidence || 'medium',
    matchedCheckId: row.checkId,
    rationale: `${row.extraClassification}: ${row.finding || row.title || ''}`,
    manualItem: { title: `Tool extra: ${row.checkId}` }
  }));
  const rows = [...manualRows, ...extraRows].filter((row) => {
    if (!filter) return true;
    if (filter.startsWith('extra:')) return row.extraClassification === filter.replace('extra:', '');
    if (filter.startsWith('partial:')) {
      const reason = filter.replace('partial:', '');
      return row.coverageStatus === 'partially_covered' && (row.partialReason === reason || (row.missingReasons || []).includes(reason));
    }
    if (filter === 'upgrade:eligible') return Boolean(row.upgradeEligible || row.sampleUpgradeEligible);
    return row.coverageStatus === filter;
  });
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="8" class="muted">Keine Einträge für diesen Filter.</td></tr>';
    return;
  }
  body.innerHTML = rows.map((row) => `
    <tr data-coverage-status="${escapeHtml(row.coverageStatus)}">
      <td>${escapeHtml(row.manualItem?.title || row.manualItemId || '')}</td>
      <td><span class="status ${escapeHtml(row.coverageStatus)}">${escapeHtml(row.coverageStatus)}</span></td>
      <td>${escapeHtml(row.confidence || '')}</td>
      <td><code>${escapeHtml((row.matchedCheckIds || [row.matchedCheckId]).filter(Boolean).join(', '))}</code></td>
      <td>${escapeHtml(row.partialReason || '')}</td>
      <td>${escapeHtml((row.matchReasons || []).join(', '))}</td>
      <td>${escapeHtml((row.missingReasons || []).join(', '))}</td>
      <td>${escapeHtml(row.rationale || '')}</td>
    </tr>
  `).join('');
}

function validationFilterButton(value, label) {
  return `<button class="quick-filter${value ? '' : ' active'}" data-validation-filter="${escapeHtml(value)}" type="button">${escapeHtml(label)}</button>`;
}

function renderMaturityPage(maturity) {
  const best = maturity.bestCategory?.name || 'NA';
  const weakest = maturity.weakestCategory?.name || 'NA';
  const weightedScore = maturity.weightedScore ?? maturity.maturityScore;
  app.innerHTML = `
    <section class="maturity-page">
      <section class="page-header maturity-hero">
        <div>
          <div class="eyebrow">GEO Audit · ${escapeHtml(maturity.domain || '')}</div>
          <h1>GEO Visibility Reifegrad</h1>
          <p class="lead">Der Reifegrad ist eine gewichtete Management-Sicht auf die vorhandenen Audit-Ergebnisse. Technische Rohdaten bleiben im Audit Workspace.</p>
          <div class="maturity-meta">
            <span class="header-tag">Run ${escapeHtml(maturity.runId)}</span>
            <span>${escapeHtml(formatDateTime(maturity.generatedAt))}</span>
            <span>${escapeHtml(maturity.maturityLabel || '')}</span>
          </div>
        </div>
        <div class="actions maturity-actions">
          <a class="button primary" data-export-download href="/api/audits/${maturity.runId}/export/full.zip" download="audit-${maturity.runId}-full-audit.zip">Full ZIP</a>
          <details class="inline-menu secondary-workspace-detail">
            <summary>Weitere Aktionen</summary>
            <div class="actions">
              <a class="button" href="#results/${maturity.runId}">Audit Workspace</a>
              <a class="button" data-export-download href="/api/audits/${maturity.runId}/export/full.json" download="audit-${maturity.runId}-full-audit.json">Full JSON</a>
              <a class="button" data-export-download href="/api/audits/${maturity.runId}/export/maturity.json" download="audit-${maturity.runId}-maturity.json">Maturity JSON</a>
            </div>
          </details>
        </div>
      </section>
      <div id="export-message" class="muted"></div>

      <section class="stats maturity-stats">
        ${maturityStat('Gesamtscore', weightedScore === null ? 'NA' : weightedScore, 'accent')}
        ${maturityStat('Prüfpunkte', `${maturity.evaluatedChecks}/${maturity.totalChecks}`)}
        ${maturityStat('Beste Kategorie', best)}
        ${maturityStat('Schwachstelle', weakest)}
      </section>

      <details class="secondary-workspace-detail maturity-method-detail">
        <summary>Methodik & Details</summary>
        <div class="grid metrics">
          ${maturityStat('Label', maturity.maturityLabel || 'NA')}
          ${maturityStat('Ungewichtet', maturity.unweightedScore === null ? 'NA' : maturity.unweightedScore)}
          ${maturityStat('Check-Schnitt', maturity.checkAverageScore === null ? 'NA' : maturity.checkAverageScore)}
          ${maturityStat('Action Items', maturity.actionItems)}
        </div>
      </details>

      ${renderMaturitySunburst(maturity)}

      <section class="maturity-category-overview">
        <h2>Kategorie-Tabelle</h2>
        <div class="table-wrap maturity-table-wrap">
          <table class="maturity-table cat-table">
            <thead><tr><th>Kategorie</th><th>Gewicht</th><th>Prüfpunkte</th><th>Score</th><th>Label</th><th>Wichtigste Empfehlung</th></tr></thead>
            <tbody>
              ${maturity.categories.map(maturityCategoryRow).join('')}
            </tbody>
          </table>
        </div>
      </section>

      ${maturityManagementSummary(maturity.managementSummary)}

      <details class="panel secondary-workspace-detail">
        <summary>Kategorie-Balken</summary>
        <p class="muted">Skala 0-10: erst Kategorie-Score, dann gewichteter Durchschnitt. OK=10, Opportunity/Best Practice=6, Warning=4, Error=1, N/A ausgeschlossen.</p>
        <div class="maturity-bars">
          ${maturity.categories.map(maturityBar).join('')}
        </div>
      </details>

      <section class="maturity-insights">
        ${maturityListPanel('Stärken', maturity.topStrengths || maturity.strengths || [], 'description')}
        ${maturityListPanel('Schwächen', maturity.topWeaknesses || maturity.weaknesses || [], 'description')}
        ${maturityListPanel('Quick Wins', maturity.quickWins || [], 'recommendation')}
        ${maturityListPanel('Strategische nächste Schritte', maturity.strategicNextSteps || maturity.nextSteps || [], 'recommendation')}
      </section>

      <details class="panel secondary-workspace-detail">
        <summary>Technische Bewertungslogik</summary>
        <pre class="evidence">${escapeHtml(JSON.stringify(maturity.scoringModel, null, 2))}</pre>
        ${maturity.uncategorizedCheckIds?.length ? `<p class="muted">Unklare Check-Zuordnungen: ${maturity.uncategorizedCheckIds.map(escapeHtml).join(', ')}</p>` : '<p class="muted">Alle im Run vorhandenen Checks wurden einer Reifegrad-Kategorie oder bewusst N/A/Unavailable zugeordnet.</p>'}
      </details>
    </section>
  `;
}

function maturityStat(label, value, className = '') {
  return `<div class="stat-card ${className}"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`;
}

function maturityManagementSummary(summary = {}) {
  return `<section class="panel management-summary">
    <div>
      <div class="eyebrow">Management Summary</div>
      <h2>${escapeHtml(summary.headline || 'Reifegrad-Zusammenfassung')}</h2>
      <p>${escapeHtml(summary.summaryText || 'Die Management Summary wird aus den vorhandenen Audit-Kategorien abgeleitet.')}</p>
    </div>
    <div class="summary-grid">
      <article>
        <span class="label">Risk Level</span>
        <strong class="risk-level">${escapeHtml(summary.riskLevel || 'unknown')}</strong>
      </article>
      <article>
        <span class="label">Stärke</span>
        <strong>${escapeHtml(summary.mainStrength?.title || 'NA')}</strong>
        <p class="muted">${escapeHtml(summary.mainStrength?.description || '')}</p>
      </article>
      <article>
        <span class="label">Hebel</span>
        <strong>${escapeHtml(summary.mainWeakness?.title || 'NA')}</strong>
        <p class="muted">${escapeHtml(summary.mainWeakness?.description || '')}</p>
      </article>
    </div>
    ${summary.recommendationFocus ? `<p class="maturity-note"><strong>Fokus:</strong> ${escapeHtml(summary.recommendationFocus)}</p>` : ''}
  </section>`;
}

function renderMaturitySunburst(maturity = {}) {
  const weightedScore = maturity.weightedScore ?? maturity.maturityScore;
  const layout = createSunburstLayout(maturity.categories || [], { size: 900 });
  const { size, center, centerRadius, categoryOuterRadius, itemInnerRadius, itemOuterRadius } = layout;
  const centerScore = weightedScore === null || weightedScore === undefined ? 'NA' : weightedScore;
  const categoryMarkup = layout.categories.map((segment) => {
    const labelPoint = polarToXY(center, center, segment.midAngle, (centerRadius + categoryOuterRadius) / 2);
    const rotation = sunburstTextRotation(segment.midAngle);
    const label = truncateText(segment.name, segment.sweep < 0.16 ? 18 : 30);
    const scoreText = segment.score === null ? 'NA' : `${segment.score}/10`;
    return `
      <g class="sunburst-category-node" data-category-id="${escapeHtml(segment.categoryId)}">
        <path class="sunburst-segment sunburst-category-segment"
          d="${sunburstArcPath(center, center, segment.startAngle, segment.endAngle, centerRadius, categoryOuterRadius)}"
          fill="${segment.color}"
          tabindex="0"
          role="listitem"
          aria-label="${escapeHtml(`${segment.name}: ${scoreText}, ${segment.itemCount} Prüfpunkte`)}"
          data-node-type="category"
          data-category-id="${escapeHtml(segment.categoryId)}"
          data-title="${escapeHtml(segment.name)}"
          data-meta="${escapeHtml(`${segment.itemCount} Prüfpunkte · Score ${scoreText} · ${segment.maturityLabel || 'Nicht bewertet'} · Gewicht ${segment.weight}`)}"
          data-score="${escapeHtml(segment.score === null ? '' : segment.score)}"
          data-status="${escapeHtml(segment.score === null ? 'NA' : segment.maturityLabel || 'OK')}"
          data-color="${escapeHtml(segment.color)}"
          data-description="${escapeHtml(segment.managementDescription)}"
          data-recommendation="${escapeHtml(segment.recommendation)}"></path>
        ${segment.sweep > 0.08 ? `<text class="sunburst-label sunburst-category-label" x="${labelPoint.x}" y="${labelPoint.y}" transform="rotate(${rotation} ${labelPoint.x} ${labelPoint.y})" text-anchor="middle" dominant-baseline="central">${escapeHtml(label)}</text>` : ''}
      </g>
    `;
  }).join('');
  const itemMarkup = layout.items.map((segment) => {
    const labelPoint = polarToXY(center, center, segment.midAngle, (itemInnerRadius + itemOuterRadius) / 2);
    const rotation = sunburstTextRotation(segment.midAngle);
    const scoreText = segment.score === null ? 'NA' : `${segment.score}/10`;
    const label = truncateText(segment.shortLabel || segment.name, segment.sweep < 0.045 ? 14 : 22);
    return `
      <g class="sunburst-item-node" data-category-id="${escapeHtml(segment.categoryId)}" data-item-id="${escapeHtml(segment.id)}">
        <path class="sunburst-segment sunburst-item-segment"
          d="${sunburstArcPath(center, center, segment.startAngle, segment.endAngle, itemInnerRadius, itemOuterRadius)}"
          fill="${segment.color}"
          tabindex="0"
          role="listitem"
          aria-label="${escapeHtml(`${segment.name}: ${scoreText}`)}"
          data-node-type="item"
          data-category-id="${escapeHtml(segment.categoryId)}"
          data-category-name="${escapeHtml(segment.categoryName)}"
          data-item-id="${escapeHtml(segment.id)}"
          data-run-id="${escapeHtml(maturity.runId)}"
          data-check-result-id="${escapeHtml(segment.checkResultId || '')}"
          data-title="${escapeHtml(`${segment.id ? `#${segment.id} ` : ''}${segment.name}`)}"
          data-meta="${escapeHtml(`${segment.categoryName} · ${scoreText} · ${segment.status || 'NA'}${segment.priority ? ` · ${segment.priority}` : ''}${segment.affectedCount ? ` · ${segment.affectedCount} betroffen` : ''}`)}"
          data-score="${escapeHtml(segment.score === null ? '' : segment.score)}"
          data-status="${escapeHtml(segment.status || 'NA')}"
          data-priority="${escapeHtml(segment.priority || '')}"
          data-finding-type="${escapeHtml(segment.findingType || '')}"
          data-confidence="${escapeHtml(segment.confidence || '')}"
          data-affected-count="${escapeHtml(segment.affectedCount || 0)}"
          data-color="${escapeHtml(segment.color)}"
          data-description="${escapeHtml(segment.finding)}"
          data-recommendation="${escapeHtml(segment.recommendation)}"></path>
        ${segment.sweep >= 0.035 && !segment.isFallback ? `<text class="sunburst-label sunburst-item-label" x="${labelPoint.x}" y="${labelPoint.y}" transform="rotate(${rotation} ${labelPoint.x} ${labelPoint.y})" text-anchor="middle" dominant-baseline="central">${escapeHtml(label)}</text>` : ''}
      </g>
    `;
  }).join('');

  return `<section class="maturity-sunburst-section">
    <div class="chart-wrap maturity-chart-wrap">
      ${layout.categories.length ? `<svg class="maturity-sunburst" viewBox="0 0 ${size} ${size}" role="img" aria-label="GEO Visibility Reifegrad Sunburst" data-category-count="${layout.categories.length}" data-item-count="${layout.items.length}">
        <g role="list">
          ${categoryMarkup}
          ${itemMarkup}
        </g>
        <circle class="sunburst-center" cx="${center}" cy="${center}" r="${centerRadius}"></circle>
        <text class="sunburst-center-label" x="${center}" y="${center - 8}" text-anchor="middle" dominant-baseline="central">Gesamt</text>
        <text class="sunburst-center-score" x="${center}" y="${center + 14}" text-anchor="middle" dominant-baseline="central">${escapeHtml(centerScore)}</text>
      </svg>` : '<p class="muted">Keine bewertbaren Kategorien für die Sunburst-Ansicht vorhanden.</p>'}
      <div class="tip maturity-tip" id="maturity-sunburst-tip" role="tooltip"></div>
    </div>
    <div class="legend-bar maturity-legend" aria-label="Reifegrad-Farblegende">
      ${maturityLegend.map((item) => `<span class="li"><span class="sw" style="background:${item.color}"></span>${escapeHtml(item.label)}</span>`).join('')}
    </div>
  </section>`;
}

function sunburstTextRotation(angle) {
  const degrees = angle * 180 / Math.PI;
  return degrees > 0 && degrees < 180 ? degrees + 180 : degrees;
}

function setupMaturitySunburstTooltip() {
  const tooltip = document.querySelector('#maturity-sunburst-tip');
  const segments = document.querySelectorAll('.sunburst-segment');
  if (!tooltip || !segments.length) return;

  const showTooltip = (segment, event) => {
    const vm = checkpointViewModelForSegment(segment);
    const color = vm.maturity.color || segment.dataset.color || 'var(--rg-none)';
    const title = segment.dataset.nodeType === 'item' && vm.checkId
      ? `#${vm.checkId} ${vm.title}`
      : vm.title;
    tooltip.innerHTML = `
      <div class="tl">${escapeHtml(title)}</div>
      <div class="tc">${escapeHtml(vm.meta)}</div>
      ${vm.finding ? `<div>${escapeHtml(vm.finding)}</div>` : ''}
      ${vm.recommendation ? `<div class="ts"><span class="td" style="background:${escapeHtml(color)}"></span><span>${escapeHtml(vm.recommendation)}</span></div>` : ''}
    `;
    tooltip.classList.add('show');
    positionMaturityTooltip(tooltip, event, segment);
    setMaturitySegmentHighlight(segment, true);
  };

  const hideTooltip = (segment) => {
    tooltip.classList.remove('show');
    setMaturitySegmentHighlight(segment, false);
  };

  for (const segment of segments) {
    segment.addEventListener('mouseenter', (event) => showTooltip(segment, event));
    segment.addEventListener('mousemove', (event) => positionMaturityTooltip(tooltip, event, segment));
    segment.addEventListener('mouseleave', () => hideTooltip(segment));
    segment.addEventListener('focus', (event) => showTooltip(segment, event));
    segment.addEventListener('blur', () => hideTooltip(segment));
    segment.addEventListener('click', (event) => {
      showTooltip(segment, event);
      navigateToSunburstItemDetail(segment);
    });
    segment.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      showTooltip(segment, event);
      navigateToSunburstItemDetail(segment);
    });
  }

  for (const row of document.querySelectorAll('.maturity-table tbody tr[data-category-id]')) {
    row.addEventListener('mouseenter', () => setMaturityCategoryHighlight(row.dataset.categoryId, true));
    row.addEventListener('mouseleave', () => setMaturityCategoryHighlight(row.dataset.categoryId, false));
  }
}

function navigateToSunburstItemDetail(segment) {
  const checkResultId = segment.dataset.checkResultId;
  const runId = segment.dataset.runId || currentRunId;
  if (segment.dataset.nodeType !== 'item' || !checkResultId || !runId) return;
  window.location.hash = `results/${runId}/check/${checkResultId}`;
}

function positionMaturityTooltip(tooltip, event, segment) {
  const rect = segment?.getBoundingClientRect?.() || { left: 24, top: 24, width: 0, height: 0 };
  const pointerX = Number.isFinite(event?.clientX) ? event.clientX : rect.left + rect.width / 2;
  const pointerY = Number.isFinite(event?.clientY) ? event.clientY : rect.top + rect.height / 2;
  const margin = 16;
  const tooltipWidth = Math.min(320, tooltip.offsetWidth || 320);
  const x = Math.min(window.innerWidth - tooltipWidth - margin, Math.max(margin, pointerX + 14));
  const y = Math.min(window.innerHeight - 120, Math.max(margin, pointerY - 10));
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

function setMaturitySegmentHighlight(segment, active) {
  if (!segment) return;
  segment.classList.toggle('is-highlighted', active);
  const categoryId = segment.dataset.categoryId;
  if (!categoryId) return;

  const categorySelector = `.sunburst-category-segment[data-category-id="${cssEscape(categoryId)}"]`;
  const categorySegment = document.querySelector(categorySelector);
  const categoryRow = document.querySelector(`.maturity-table tbody tr[data-category-id="${cssEscape(categoryId)}"]`);
  categoryRow?.classList.toggle('is-highlighted', active);

  if (segment.dataset.nodeType === 'item') {
    categorySegment?.classList.toggle('is-related', active);
    return;
  }

  categorySegment?.classList.toggle('is-highlighted', active);
}

function setMaturityCategoryHighlight(categoryId, active) {
  if (!categoryId) return;
  const selector = `.sunburst-category-segment[data-category-id="${cssEscape(categoryId)}"]`;
  document.querySelector(selector)?.classList.toggle('is-highlighted', active);
  document.querySelector(`.maturity-table tbody tr[data-category-id="${cssEscape(categoryId)}"]`)?.classList.toggle('is-highlighted', active);
}

function maturityBar(category) {
  const score = category.score === null ? 0 : category.score;
  const width = category.normalizedScore === null ? 0 : Math.max(0, Math.min(100, category.normalizedScore));
  return `<div class="maturity-bar-row">
    <div>
      <strong>${escapeHtml(category.name)}</strong>
      <span class="muted">${escapeHtml(category.evaluatedCount)} bewertet · Gewicht ${escapeHtml(category.weight)} · ${escapeHtml(category.maturityLabel)}</span>
    </div>
    <div class="maturity-bar-bg" aria-label="${escapeHtml(category.name)} ${escapeHtml(score)} von 10">
      <span class="maturity-bar-fill" style="width:${width}%;background:${maturityColor(score)}"></span>
    </div>
    <strong class="maturity-score">${category.score === null ? 'NA' : escapeHtml(category.score)}</strong>
  </div>`;
}

function maturityCategoryRow(category) {
  const recommendation = category.keyFindings.length
    ? category.keyFindings.slice(0, 2).map((item) => `${item.checkId}: ${item.recommendation || item.finding || item.title}`).join('\n')
    : category.recommendation;
  return `<tr data-category-id="${escapeHtml(category.id || category.name)}">
    <td class="cat-name">${escapeHtml(category.name)}<div class="muted">${escapeHtml(category.description)}</div></td>
    <td><strong>${escapeHtml(category.weight)}</strong><div class="muted">${escapeHtml(category.weightShare || 0)}% Anteil</div></td>
    <td>${escapeHtml(category.evaluatedCount)} / ${escapeHtml(category.checkCount)}</td>
    <td class="cat-score" style="color:${maturityColor(category.score)}">${category.score === null ? 'NA' : escapeHtml(category.score)}</td>
    <td class="cat-bar"><div class="bar-bg"><div class="bar-fill" style="width:${category.normalizedScore || 0}%;background:${maturityColor(category.score)}"></div></div><div class="muted">${escapeHtml(category.maturityLabel)}</div></td>
    <td>${escapeHtml(recommendation)}</td>
  </tr>`;
}

function maturityListPanel(title, items = [], bodyKey) {
  return `<section class="panel">
    <h2>${escapeHtml(title)}</h2>
    ${items.length ? `<div class="maturity-list">${items.map((item) => `<article>
      <strong>${escapeHtml(item.title)}</strong>
      <div class="maturity-list-tags">
        ${item.categoryId ? `<span>${escapeHtml(item.categoryId)}</span>` : ''}
        ${item.checkId ? `<span>${escapeHtml(item.checkId)}</span>` : ''}
        ${item.priority ? `<span>${escapeHtml(item.priority)}</span>` : ''}
        ${item.effort ? `<span>Effort ${escapeHtml(item.effort)}</span>` : ''}
      </div>
      <div class="muted">${item.score !== undefined ? `Score ${escapeHtml(item.score)} · ` : ''}${escapeHtml(item[bodyKey] || item.description || item.recommendation || '')}</div>
    </article>`).join('')}</div>` : '<p class="muted">Keine Einträge für diesen Bereich.</p>'}
  </section>`;
}

function maturityColor(score) {
  return scoreToColor(score);
}

function setupExportDownloads() {
  for (const link of document.querySelectorAll('[data-export-download]')) {
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      const message = document.querySelector('#export-message');
      message.textContent = 'Export wird vorbereitet...';
      const endpoint = link.getAttribute('href') || link.href;
      try {
        const response = await fetch(endpoint, {
          headers: { accept: 'application/zip, application/json, application/octet-stream, */*' }
        });
        if (!response.ok) {
          const serverMessage = await exportErrorMessage(response);
          throw new Error(`${endpoint} · HTTP ${response.status} · ${serverMessage}`);
        }
        const blob = await response.blob();
        const downloadName = fileNameFromDisposition(response.headers.get('content-disposition')) || link.href.split('/').pop() || 'audit-export';
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = downloadName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        message.textContent = `Export bereit: ${downloadName}`;
      } catch (error) {
        message.textContent = `Export fehlgeschlagen: ${error.message}`;
      }
    });
  }
}

async function exportErrorMessage(response) {
  const text = await response.text();
  if (!text) return response.statusText || 'Unknown export error';
  try {
    const payload = JSON.parse(text);
    return payload.message || payload.error || text;
  } catch {
    return text;
  }
}

function fileNameFromDisposition(value) {
  const match = String(value || '').match(/filename="?([^";]+)"?/i);
  return match ? match[1] : '';
}

function renderScoreCards(scores, run = {}, samplingSummary = {}) {
  document.querySelector('#scores').innerHTML = `
    ${score('Tech Score', scores.techScore)}
    ${score('GEO Readiness Score', scores.geoScore)}
    ${score('Overall Score', scores.overallScore)}
    ${metric('Run ID', run.id ?? currentRunId)}
    ${metric('Status', `<span class="status ${escapeHtml(run.status || 'NA')}">${escapeHtml(run.status || 'NA')}</span>`)}
    ${metric('URLs', `${run.successfulUrls ?? 0} ok / ${run.failedUrls ?? 0} failed`)}
    ${metric('Playwright', escapeHtml(samplingSummary.renderingStatus || (samplingSummary.enablePlaywrightSampling ? 'enabled' : 'disabled')))}
    ${metric('Lighthouse', escapeHtml(samplingSummary.lighthouseStatus || (samplingSummary.enableLighthouseSampling ? 'enabled' : 'disabled')))}
  `;
}

function renderResultsRunContext(run = {}) {
  const parts = [
    `Domain: ${escapeHtml(run.finalDomain || run.inputDomain || '')}`,
    `Status: ${escapeHtml(run.status || '')}`,
    `Trigger: ${escapeHtml(run.triggerType || 'manual')}`
  ];
  if (run.schedule?.name || run.scheduleName) parts.push(`Schedule: ${escapeHtml(run.schedule?.name || run.scheduleName)}`);
  if (run.baselineRunId) parts.push(`Baseline Run: ${escapeHtml(run.baselineRunId)}`);
  document.querySelector('#results-run-context').innerHTML = parts.join(' · ');
}

function renderReviewSummary(summary = {}) {
  document.querySelector('#review-summary').innerHTML = `
    ${metric('Reviewed', `${summary.reviewed ?? 0}/${summary.reviewableFindings ?? 0}`)}
    ${metric('Unreviewed', summary.unreviewed ?? 0)}
    ${metric('Needs Fix', summary.needsFix ?? 0)}
    ${metric('False Positive', summary.falsePositive ?? 0)}
    ${metric('Done', summary.done ?? 0)}
    ${metric('Review Recommended', summary.reviewRecommendedCount ?? 0)}
    ${metric('Passed', summary.passedChecks ?? 0)}
    ${metric('Not Required', summary.notRequired ?? 0)}
  `;
}

function renderSamplingSummary(summary = {}) {
  document.querySelector('#sampling-summary').innerHTML = `
    ${metric('Samples', `${summary.samplesProcessed ?? 0}/${summary.samplesTotal ?? 0}`)}
    ${metric('Sample Rows', summary.sampleRows ?? 0)}
    ${metric('Template Playwright', summary.renderingStatus || (summary.enablePlaywrightSampling ? 'enabled' : 'disabled'))}
    ${metric('Playwright OK', summary.playwrightSuccessCount ?? 0)}
    ${metric('Template Lighthouse', summary.lighthouseStatus || (summary.enableLighthouseSampling ? 'enabled' : 'disabled'))}
    ${metric('Lighthouse OK', summary.lighthouseSuccessCount ?? 0)}
    ${metric('Sampling Errors', summary.sampleErrorCount ?? 0)}
  `;
  const notes = [];
  notes.push(summary.enableTemplateSampling
    ? 'Template sampling nutzt repräsentative URLs pro Cluster, nicht jede URL des Crawls.'
    : 'Template sampling ist für diesen Run deaktiviert.');
  if (summary.renderingStatusMessage) notes.push(summary.renderingStatusMessage);
  if (summary.lighthouseStatusMessage) notes.push(summary.lighthouseStatusMessage);
  document.querySelector('#sampling-note').textContent = notes.join(' ');
}

function setupFilters(results, runId) {
  populateSelect('#filter-status', unique(results.map((row) => row.effectiveStatus || row.status)));
  populateSelect('#filter-priority', unique(results.map((row) => row.effectivePriority || row.priority)));
  populateSelect('#filter-finding-type', unique(results.map((row) => row.normalizedFindingType || row.findingType)));
  populateSelect('#filter-confidence', unique(results.map((row) => row.confidence)));
  populateSelect('#filter-review-status', unique(results.map((row) => row.displayReviewStatus || row.reviewStatus || 'unreviewed')));
  populateSelect('#filter-action-status', unique(results.map((row) => row.displayActionStatus || row.actionStatus || 'open')));
  populateSelect('#filter-category', unique(results.map((row) => row.category)));
  const syncFilters = async () => {
      resultsState.status = document.querySelector('#filter-status').value;
      resultsState.priority = document.querySelector('#filter-priority').value;
      resultsState.findingType = document.querySelector('#filter-finding-type').value;
      resultsState.confidence = document.querySelector('#filter-confidence').value;
      resultsState.reviewRecommended = document.querySelector('#filter-review-recommended').value;
      resultsState.reviewStatus = document.querySelector('#filter-review-status').value;
      resultsState.actionStatus = document.querySelector('#filter-action-status').value;
      resultsState.category = document.querySelector('#filter-category').value;
      resultsState.search = document.querySelector('#filter-search').value.trim();
      resultsState.sort = document.querySelector('#filter-sort').value || 'recommended';
      resultsState.needsReview = false;
      await refreshResults(runId);
  };
  for (const id of ['filter-status', 'filter-priority', 'filter-finding-type', 'filter-confidence', 'filter-review-recommended', 'filter-review-status', 'filter-action-status', 'filter-category', 'filter-sort']) {
    document.querySelector(`#${id}`).addEventListener('change', syncFilters);
  }
  document.querySelector('#filter-search').addEventListener('input', syncFilters);
  for (const button of document.querySelectorAll('[data-quick-filter]')) {
    button.addEventListener('click', async () => {
      resultsState.quickFilter = button.getAttribute('data-quick-filter') || '';
      resultsState.needsReview = false;
      updateQuickFilterButtons();
      await refreshResults(runId);
    });
  }
  document.querySelector('#needs-review-filter').addEventListener('click', async () => {
    resultsState.needsReview = true;
    resultsState.quickFilter = 'needs-review';
    updateQuickFilterButtons();
    await refreshResults(runId);
  });
  document.querySelector('#clear-review-filter').addEventListener('click', async () => {
    for (const id of ['filter-status', 'filter-priority', 'filter-finding-type', 'filter-confidence', 'filter-review-recommended', 'filter-review-status', 'filter-action-status', 'filter-category', 'filter-sort']) {
      document.querySelector(`#${id}`).value = '';
    }
    document.querySelector('#filter-sort').value = 'recommended';
    document.querySelector('#filter-search').value = '';
    resultsState.status = '';
    resultsState.priority = '';
    resultsState.findingType = '';
    resultsState.confidence = '';
    resultsState.reviewRecommended = '';
    resultsState.reviewStatus = '';
    resultsState.actionStatus = '';
    resultsState.category = '';
    resultsState.needsReview = false;
    resultsState.quickFilter = '';
    resultsState.search = '';
    resultsState.sort = 'recommended';
    updateQuickFilterButtons();
    await refreshResults(runId);
  });
}

function renderFindings(results) {
  setCurrentResults(results);
  const filtered = sortResultsForCards(results.filter(matchesResultFilters));
  const container = document.querySelector('#findings');
  if (!filtered.length) {
    container.innerHTML = '<div class="panel empty">Keine Findings für diese Filter.</div>';
    updateBulkCount();
    return;
  }
  const body = filtered.map(checkCard).join('');
  container.innerHTML = `
    <div class="check-card-toolbar">
      <label class="inline-check"><input id="select-all-findings" type="checkbox" aria-label="Alle sichtbaren Findings auswählen"> Sichtbare auswählen</label>
      <span class="muted">${filtered.length} Checks sichtbar</span>
    </div>
    ${body}
  `;
  container.querySelector('#select-all-findings')?.addEventListener('change', (event) => {
    for (const row of filtered) {
      if (event.target.checked) selectedFindings.add(row.id);
      else selectedFindings.delete(row.id);
    }
    renderFindings(currentResults);
  });
  for (const checkbox of container.querySelectorAll('[data-select-finding]')) {
    checkbox.addEventListener('change', () => {
      const id = Number(checkbox.getAttribute('data-select-finding'));
      if (checkbox.checked) selectedFindings.add(id);
      else selectedFindings.delete(id);
      updateBulkCount();
    });
  }
  for (const button of container.querySelectorAll('[data-review-finding], [data-detail-finding]')) {
    button.addEventListener('click', () => {
      const id = Number(button.getAttribute('data-review-finding') || button.getAttribute('data-detail-finding'));
      openReviewModal(id);
    });
  }
  updateBulkCount();
}

function matchesResultFilters(row) {
  const status = resultStatus(row);
  const priority = resultPriority(row);
  const findingType = row.normalizedFindingType || row.findingType || '';
  const confidence = row.confidence || '';
  const reviewStatus = resultReviewStatus(row);
  const actionStatus = resultActionStatus(row);
  const search = resultsState.search.toLowerCase();
  return (!resultsState.status || status === resultsState.status) &&
    (!resultsState.priority || priority === resultsState.priority) &&
    (!resultsState.findingType || findingType === resultsState.findingType) &&
    (!resultsState.confidence || confidence === resultsState.confidence) &&
    (!resultsState.reviewRecommended || (resultsState.reviewRecommended === 'yes' ? Boolean(row.displayReviewRecommended) : !row.displayReviewRecommended)) &&
    (!resultsState.reviewStatus || reviewStatus === resultsState.reviewStatus) &&
    (!resultsState.actionStatus || actionStatus === resultsState.actionStatus) &&
    (!resultsState.category || row.category === resultsState.category) &&
    (!resultsState.needsReview || needsReview(row)) &&
    (!resultsState.quickFilter || matchesQuickFilter(row, resultsState.quickFilter)) &&
    (!search || resultSearchText(row).includes(search));
}

function matchesQuickFilter(row, quickFilter) {
  const status = resultStatus(row);
  const reviewStatus = resultReviewStatus(row);
  if (quickFilter === 'needs-review') return needsReview(row);
  if (quickFilter === 'todo' || quickFilter === 'action' || quickFilter === 'error') {
    return ['Error', 'Warning'].includes(status) &&
      !isOpportunityResult(row) &&
      !isBestPracticeResult(row) &&
      !['false_positive', 'ignored', 'fixed'].includes(reviewStatus);
  }
  if (quickFilter === 'warning') return resultStatus(row) === 'Warning' && !isOpportunityResult(row) && !isBestPracticeResult(row);
  if (quickFilter === 'opportunities') return isOpportunityResult(row) && !isPassedResult(row) && !isNaResult(row);
  if (quickFilter === 'passed') return isPassedResult(row);
  if (quickFilter === 'na') return isNaResult(row);
  return true;
}

function sortResultsForCards(rows) {
  const sorted = [...rows];
  const sort = resultsState.sort || 'recommended';
  sorted.sort((a, b) => {
    if (sort === 'category') return String(a.category || '').localeCompare(String(b.category || '')) || recommendedRank(a) - recommendedRank(b);
    if (sort === 'status') return statusRank(resultStatus(a)) - statusRank(resultStatus(b)) || recommendedRank(a) - recommendedRank(b);
    if (sort === 'priority') return priorityRank(resultPriority(a)) - priorityRank(resultPriority(b)) || recommendedRank(a) - recommendedRank(b);
    return recommendedRank(a) - recommendedRank(b) ||
      priorityRank(resultPriority(a)) - priorityRank(resultPriority(b)) ||
      String(a.category || '').localeCompare(String(b.category || '')) ||
      Number(b.affectedCount || 0) - Number(a.affectedCount || 0);
  });
  return sorted;
}

function recommendedRank(row) {
  const status = resultStatus(row);
  if (status === 'Error') return 0;
  if (isActionItemResult(row)) return 5;
  if (status === 'Warning' && !isOpportunityResult(row) && !isBestPracticeResult(row)) return 10;
  if (isOpportunityResult(row) && !isPassedResult(row) && !isNaResult(row)) return 20;
  if (isBestPracticeResult(row)) return 30;
  if (isPassedResult(row)) return 40;
  if (isNaResult(row)) return 50;
  return 60;
}

function checkCard(row) {
  const vm = checkpointViewModel(row);
  const displayStatus = vm.status;
  const priority = vm.priority;
  const reviewStatus = resultReviewStatus(row);
  const actionStatus = resultActionStatus(row);
  const type = vm.findingType;
  const confidence = vm.confidence;
  const samples = (row.sampleUrls || []).slice(0, 3);
  const maturity = vm.maturity;
  return `
    <article class="check-card check-card-${escapeHtml(displayStatus)}" data-check-card-id="${escapeHtml(row.id)}" style="--check-card-color:${escapeHtml(maturity.color)}">
      <div class="check-card-head">
        <label class="inline-check"><input data-select-finding="${row.id}" type="checkbox" ${selectedFindings.has(row.id) ? 'checked' : ''}> Auswahl</label>
        <div class="check-title">
          <h3>${escapeHtml(vm.title)}</h3>
          <div class="muted">${escapeHtml(vm.checkId)} · ${escapeHtml(vm.category)}</div>
        </div>
        <div class="check-status">
          <span class="status ${escapeHtml(displayStatus)} maturity-status" style="--status-color:${escapeHtml(maturity.color)}">${escapeHtml(displayStatus)}</span>
          ${maturity.scoreLabel ? `<span class="maturity-score-pill" style="--status-color:${escapeHtml(maturity.color)}">Reifegrad ${escapeHtml(maturity.scoreLabel)}</span>` : ''}
          <strong>${escapeHtml(priority || 'NA')}</strong>
          ${row.hasManualOverride ? '<span class="manual-badge">manual override applied</span>' : ''}
        </div>
      </div>
      <div class="check-tags">
        ${type ? `<span>${escapeHtml(type)}</span>` : ''}
        ${confidence ? `<span>confidence: ${escapeHtml(confidence)}</span>` : ''}
        ${row.displayReviewRecommended ? '<span>review recommended</span>' : ''}
        <span>${Number(row.affectedCount || 0)} betroffen</span>
      </div>
      <div class="check-copy-grid">
        <section><span class="muted">Was wurde geprüft</span><p>${escapeHtml(vm.checked)}</p></section>
        <section><span class="muted">Das wurde gefunden</span><p>${escapeHtml(vm.finding)}</p></section>
        <section><span class="muted">Empfehlung</span><p>${escapeHtml(vm.recommendation)}</p></section>
      </div>
      ${samples.length ? `<div class="sample-list"><span class="muted">Beispiele</span>${samples.map((url) => `<code>${escapeHtml(url)}</code>`).join('')}</div>` : ''}
      <div class="check-card-foot">
        <div class="review-pills">
          <span>Review: ${escapeHtml(reviewStatus)}</span>
          <span>Action: ${escapeHtml(actionStatus)}</span>
        </div>
        <div class="actions">
          <button data-review-finding="${row.id}" type="button">${row.reviewId ? 'Bearbeiten' : 'Review'}</button>
          <button data-detail-finding="${row.id}" type="button">Details ansehen</button>
          <a class="button" href="/api/audits/${currentRunId}/check-results/${row.id}/export.csv">CSV</a>
        </div>
      </div>
    </article>
  `;
}

function focusFindingCard(checkResultId) {
  const card = document.querySelector(`[data-check-card-id="${cssEscape(checkResultId)}"]`);
  if (!card) return;
  card.classList.add('is-deep-linked');
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cardStatusLabel(row) {
  const maturity = maturityItemForResult(row);
  if (maturity && maturity.status && maturity.score !== null && maturity.score !== undefined && Number(maturity.score) < 10) {
    return maturity.status;
  }
  if (isNaResult(row)) return 'NA';
  if (isPassedResult(row)) return 'OK';
  if (isOpportunityResult(row)) return 'Opportunity';
  if (isActionItemResult(row)) return 'ToDo';
  return resultStatus(row);
}

function setCurrentMaturityIndex(maturity = null) {
  currentMaturityByCheckId = new Map();
  currentMaturityByCheckResultId = new Map();
  for (const category of maturity?.categories || []) {
    for (const item of category.items || []) {
      if (item.id) currentMaturityByCheckId.set(String(item.id), item);
      if (item.checkResultId !== null && item.checkResultId !== undefined) {
        currentMaturityByCheckResultId.set(Number(item.checkResultId), item);
      }
    }
  }
}

function setCurrentResults(results = []) {
  currentResults = results;
  currentResultsById = new Map(results.map((row) => [Number(row.id), row]));
}

function maturityItemForResult(row = {}) {
  return currentMaturityByCheckResultId.get(Number(row.id)) ||
    currentMaturityByCheckId.get(String(row.checkId || '')) ||
    null;
}

function resultForCheckResultId(checkResultId) {
  const numericId = Number(checkResultId);
  return Number.isFinite(numericId) ? currentResultsById.get(numericId) || null : null;
}

function resultMaturityMeta(row = {}) {
  const item = maturityItemForResult(row);
  if (!item || item.score === null || item.score === undefined) {
    return { item, score: null, scoreLabel: '', color: scoreToColor(null) };
  }
  const numericScore = Number(item.score);
  return {
    item,
    score: Number.isFinite(numericScore) ? numericScore : null,
    scoreLabel: Number.isFinite(numericScore) ? `${numericScore}/10` : '',
    color: scoreToColor(Number.isFinite(numericScore) ? numericScore : null)
  };
}

function segmentMaturityMeta(segment = null) {
  const scoreValue = segment?.dataset?.score;
  if (scoreValue === null || scoreValue === undefined || scoreValue === '') {
    return { item: null, score: null, scoreLabel: '', color: segment?.dataset?.color || scoreToColor(null) };
  }
  const numericScore = Number(scoreValue);
  return {
    item: null,
    score: Number.isFinite(numericScore) ? numericScore : null,
    scoreLabel: Number.isFinite(numericScore) ? `${numericScore}/10` : '',
    color: segment?.dataset?.color || scoreToColor(Number.isFinite(numericScore) ? numericScore : null)
  };
}

function checkpointViewModel(row = {}, segment = null) {
  const hasRow = Boolean(row?.id);
  const maturity = hasRow ? resultMaturityMeta(row) : segmentMaturityMeta(segment);
  const status = hasRow ? cardStatusLabel(row) : (segment?.dataset?.status || 'NA');
  const priority = hasRow ? resultPriority(row) : (segment?.dataset?.priority || '');
  const category = hasRow ? (row.category || '') : (segment?.dataset?.categoryName || segment?.dataset?.categoryId || '');
  const title = hasRow ? (row.checkName || row.checkId || '') : (segment?.dataset?.title || '');
  const checkId = hasRow ? (row.checkId || '') : (segment?.dataset?.itemId || '');
  const finding = hasRow
    ? (row.effectiveFinding || row.finding || (isPassedResult(row) ? 'Keine Auffälligkeit in den gespeicherten Auditdaten.' : ''))
    : (segment?.dataset?.description || '');
  const recommendation = hasRow
    ? (row.effectiveRecommendation || row.recommendation || 'Keine konkrete Maßnahme erforderlich.')
    : (segment?.dataset?.recommendation || 'Keine konkrete Maßnahme erforderlich.');
  const checked = hasRow ? checkedText(row) : (segment?.dataset?.checked || segment?.dataset?.meta || '');
  return {
    row,
    segment,
    maturity,
    status,
    priority,
    category,
    title,
    checkId,
    finding,
    recommendation,
    checked,
    findingType: hasRow ? (row.normalizedFindingType || row.findingType || '') : (segment?.dataset?.findingType || ''),
    confidence: hasRow ? (row.confidence || '') : (segment?.dataset?.confidence || ''),
    affectedCount: Number(hasRow ? row.affectedCount || 0 : segment?.dataset?.affectedCount || 0),
    meta: hasRow
      ? `${category}${maturity.scoreLabel ? ` · ${maturity.scoreLabel}` : ''} · ${status}${priority ? ` · ${priority}` : ''}`
      : (segment?.dataset?.meta || `${category}${maturity.scoreLabel ? ` · ${maturity.scoreLabel}` : ''} · ${status}${priority ? ` · ${priority}` : ''}`)
  };
}

function checkpointViewModelForSegment(segment) {
  const row = resultForCheckResultId(segment?.dataset?.checkResultId);
  return row ? checkpointViewModel(row, segment) : checkpointViewModel({}, segment);
}

function resultStatus(row) {
  return row.effectiveStatus || row.displayStatus || row.status || 'NA';
}

function resultPriority(row) {
  return row.effectivePriority || row.priority || 'Low';
}

function resultReviewStatus(row) {
  return row.displayReviewStatus || row.reviewStatus || 'unreviewed';
}

function resultActionStatus(row) {
  return row.displayActionStatus || row.actionStatus || 'open';
}

function resultSearchText(row) {
  return [
    row.checkId,
    row.checkName,
    row.category,
    row.details,
    row.effectiveFinding,
    row.finding,
    row.effectiveRecommendation,
    row.recommendation,
    row.normalizedFindingType,
    row.findingType,
    row.confidence,
    ...(row.sampleUrls || [])
  ].filter(Boolean).join(' ').toLowerCase();
}

function isPassedResult(row) {
  return resultStatus(row) === 'OK' || row.reportSection === 'passed_checks';
}

function isNaResult(row) {
  return resultStatus(row) === 'NA' || row.reportSection === 'not_applicable_checks';
}

function isOpportunityResult(row) {
  const type = String(row.normalizedFindingType || row.findingType || '').toLowerCase();
  const grouping = String(row.reportGroupingKey || '').toLowerCase();
  return type.includes('opportunity') || grouping.includes('opportunity');
}

function isBestPracticeResult(row) {
  return String(row.normalizedFindingType || row.findingType || '').toLowerCase() === 'best_practice';
}

function isActionItemResult(row) {
  const reviewStatus = resultReviewStatus(row);
  return ['Error', 'Warning'].includes(resultStatus(row)) &&
    !isOpportunityResult(row) &&
    !isBestPracticeResult(row) &&
    !['false_positive', 'ignored', 'fixed'].includes(reviewStatus);
}

function checkedText(row) {
  if (row.details) return row.details;
  if (row.reportSection === 'template_performance') return 'Representative Template-Samples wurden mit lokalem Rendering/Lighthouse ausgewertet.';
  if (row.category) return `${row.category}: ${row.checkName || row.checkId}`;
  return row.checkName || row.checkId || '';
}

function statusRank(status) {
  return { Error: 0, Warning: 1, ToDo: 2, Opportunity: 3, NA: 4, OK: 5 }[status] ?? 6;
}

function priorityRank(priority) {
  return { High: 0, Medium: 1, Low: 2 }[priority] ?? 3;
}

function updateQuickFilterButtons() {
  for (const button of document.querySelectorAll('[data-quick-filter]')) {
    button.classList.toggle('active', (button.getAttribute('data-quick-filter') || '') === resultsState.quickFilter);
  }
}

function setupBulkActions(runId) {
  document.querySelector('#bulk-apply').addEventListener('click', async () => {
    const checkResultIds = [...selectedFindings];
    if (!checkResultIds.length) {
      window.alert('Bitte mindestens ein Finding auswählen.');
      return;
    }
    const payload = {
      checkResultIds,
      reviewStatus: document.querySelector('#bulk-review-status').value || undefined,
      actionStatus: document.querySelector('#bulk-action-status').value || undefined,
      manualPriority: document.querySelector('#bulk-manual-priority').value || undefined,
      note: document.querySelector('#bulk-note').value || undefined
    };
    if (!payload.reviewStatus && !payload.actionStatus && !payload.manualPriority && !payload.note) {
      window.alert('Bitte mindestens ein Bulk-Feld setzen.');
      return;
    }
    await fetchJson(`/api/audits/${runId}/reviews/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    await refreshResults(runId);
  });
}

function setupReviewModal(runId) {
  document.querySelector('#review-close').addEventListener('click', closeReviewModal);
  document.querySelector('#review-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const checkResultId = Number(document.querySelector('#review-check-result-id').value);
    const payload = {
      reviewStatus: document.querySelector('#review-status').value,
      actionStatus: document.querySelector('#review-action-status').value,
      manualStatus: document.querySelector('#review-manual-status').value || null,
      manualPriority: document.querySelector('#review-manual-priority').value || null,
      manualEffort: document.querySelector('#review-manual-effort').value || null,
      manualFinding: document.querySelector('#review-manual-finding').value || null,
      manualRecommendation: document.querySelector('#review-manual-recommendation').value || null,
      note: document.querySelector('#review-note').value || null,
      reviewerName: document.querySelector('#reviewer-name').value || null
    };
    const message = document.querySelector('#review-message');
    message.textContent = 'Speichert...';
    await fetchJson(`/api/audits/${runId}/check-results/${checkResultId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    message.textContent = 'Gespeichert.';
    await refreshResults(runId);
    await openReviewModal(checkResultId);
  });
  document.querySelector('#review-delete').addEventListener('click', async () => {
    const checkResultId = Number(document.querySelector('#review-check-result-id').value);
    await fetchJson(`/api/audits/${runId}/check-results/${checkResultId}/review`, { method: 'DELETE' });
    closeReviewModal();
    await refreshResults(runId);
  });
}

async function openReviewModal(checkResultId) {
  const row = currentResults.find((item) => item.id === checkResultId);
  if (!row) return;
  document.querySelector('#review-check-result-id').value = String(row.id);
  document.querySelector('#review-modal-title').textContent = `${row.checkId} · Review`;
  document.querySelector('#review-original').innerHTML = `
    <dt>Status</dt><dd>${escapeHtml(row.status)}</dd>
    <dt>Priority</dt><dd>${escapeHtml(row.priority)}</dd>
    <dt>Effort</dt><dd>${escapeHtml(row.effort)}</dd>
    <dt>Finding</dt><dd>${escapeHtml(row.finding || '')}</dd>
    <dt>Recommendation</dt><dd>${escapeHtml(row.recommendation || '')}</dd>
    <dt>Details</dt><dd>${escapeHtml(row.details || '')}</dd>
  `;
  document.querySelector('#review-evidence').textContent = JSON.stringify(row.evidence || {}, null, 2);
  document.querySelector('#check-detail-narrative').innerHTML = '<p class="muted">Lädt Detaildaten...</p>';
  document.querySelector('#check-detail-table').innerHTML = '';
  document.querySelector('#check-detail-export').href = `/api/audits/${currentRunId}/check-results/${row.id}/export.csv`;
  document.querySelector('#review-status').value = row.reviewStatus || 'unreviewed';
  document.querySelector('#review-action-status').value = row.actionStatus || 'open';
  document.querySelector('#review-manual-status').value = row.manualStatus || '';
  document.querySelector('#review-manual-priority').value = row.manualPriority || '';
  document.querySelector('#review-manual-effort').value = row.manualEffort || '';
  document.querySelector('#review-manual-finding').value = row.manualFinding || '';
  document.querySelector('#review-manual-recommendation').value = row.manualRecommendation || '';
  document.querySelector('#review-note').value = row.reviewNote || '';
  document.querySelector('#reviewer-name').value = row.reviewerName || '';
  document.querySelector('#review-message').textContent = '';
  document.querySelector('#review-modal').hidden = false;
  try {
    const detail = await fetchJson(`/api/audits/${currentRunId}/check-results/${checkResultId}/details?limit=500`);
    renderCheckDetail(detail);
    document.querySelector('#review-evidence').textContent = JSON.stringify(detail.evidence || row.evidence || {}, null, 2);
  } catch (error) {
    document.querySelector('#check-detail-narrative').innerHTML = `<p class="muted">Detaildaten konnten nicht geladen werden: ${escapeHtml(error.message)}</p>`;
  }
}

function closeReviewModal() {
  document.querySelector('#review-modal').hidden = true;
  if (currentRunId && /^#results\/\d+\/check\/\d+$/.test(window.location.hash)) {
    window.history.replaceState(null, '', `#results/${currentRunId}`);
  }
}

async function refreshResults(runId = currentRunId) {
  const fresh = await fetchJson(`/api/audits/${runId}/results`);
  setCurrentResults(fresh.results);
  renderReviewSummary(fresh.reviewSummary);
  renderFindings(fresh.results);
}

function needsReview(row) {
  const confidence = String(row.confidence || '').toLowerCase();
  return resultReviewStatus(row) === 'unreviewed' &&
    !['OK', 'NA'].includes(resultStatus(row)) &&
    (Boolean(row.displayReviewRecommended) || ['low', 'medium'].includes(confidence) || Boolean(row.isReviewable));
}

function renderCheckDetail(detail) {
  const narrative = detail.context || {};
  document.querySelector('#check-detail-export').href = `/api/audits/${currentRunId}/check-results/${detail.checkResultId}/export.csv`;
  document.querySelector('#check-detail-narrative').innerHTML = `
    <div class="detail-meta">
      <span>Status: ${escapeHtml(detail.displayStatus || detail.effectiveStatus || detail.status || '')}</span>
      <span>Priority: ${escapeHtml(detail.effectivePriority || detail.priority || '')}</span>
      <span>Finding Type: ${escapeHtml(detail.normalizedFindingType || detail.findingType || '')}</span>
      <span>Confidence: ${escapeHtml(detail.confidence || '')}</span>
    </div>
    <dl class="kv detail-kv">
      <dt>Das ist der Prüfpunkt</dt><dd>${escapeHtml(narrative.whatChecked || detail.title || detail.checkId)}</dd>
      <dt>Warum ist das wichtig?</dt><dd>${escapeHtml(narrative.relevance || '')}</dd>
      <dt>So wurde geprüft</dt><dd>${escapeHtml(narrative.howChecked || detail.dataSource || 'stored crawl data')}</dd>
      <dt>Das wurde gefunden</dt><dd>${escapeHtml(narrative.found || '')}</dd>
      <dt>Empfehlung</dt><dd>${escapeHtml(narrative.recommendation || '')}</dd>
    </dl>
  `;
  const columns = detail.columns || [];
  const rows = detail.rows || [];
  if (!rows.length || !columns.length) {
    document.querySelector('#check-detail-table').innerHTML = '<div class="empty">Keine Detailzeilen vorhanden.</div>';
    return;
  }
  document.querySelector('#check-detail-table').innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr>${columns.map((column) => `<th>${escapeHtml(column.label || column.key)}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(formatCell(row[column.key]))}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${detail.truncated ? '<p class="muted">Detailansicht gekürzt. Vollständiger Export per CSV.</p>' : ''}
  `;
}

function updateBulkCount() {
  const label = document.querySelector('#bulk-count');
  if (label) label.textContent = `${selectedFindings.size} ausgewählt`;
  const bulkSection = document.querySelector('#bulk-section');
  if (bulkSection) bulkSection.hidden = selectedFindings.size === 0;
}

async function renderPages(runId) {
  const payload = await fetchJson(`/api/audits/${runId}/pages?page=${resultsState.page}&limit=50`);
  document.querySelector('#page-label').textContent = `${payload.page} / ${Math.max(1, Math.ceil(payload.total / payload.limit))}`;
  document.querySelector('#prev-page').disabled = payload.page <= 1;
  document.querySelector('#next-page').disabled = payload.page >= Math.ceil(payload.total / payload.limit);
  document.querySelector('#prev-page').onclick = async () => {
    resultsState.page = Math.max(1, resultsState.page - 1);
    await renderPages(runId);
  };
  document.querySelector('#next-page').onclick = async () => {
    resultsState.page += 1;
    await renderPages(runId);
  };
  document.querySelector('#pages').innerHTML = `
    <thead><tr>
      <th>URL</th><th>Type</th><th>Status</th><th>Title</th><th>H1</th><th>Words Raw</th><th>Words Rendered</th><th>Links</th><th>Signals</th><th>Images</th><th>TTFB</th><th>Schema</th>
    </tr></thead>
    <tbody>
      ${payload.pages.map((page) => `<tr>
        <td>${escapeHtml(page.url)}</td>
        <td>${escapeHtml(page.pageType || 'other')}</td>
        <td>${page.statusCode ?? ''}</td>
        <td>${escapeHtml(page.title || '')}</td>
        <td>${page.h1Count ?? ''}</td>
        <td>${page.wordCountRaw ?? ''}</td>
        <td>${page.wordCountRendered ?? ''}</td>
        <td>${page.internalLinksCount ?? 0} / ${page.externalLinksCount ?? 0}</td>
        <td>${escapeHtml(structureSignals(page))}</td>
        <td>${page.imagesWithoutAltCount ?? 0} / ${page.imagesCount ?? 0}</td>
        <td>${page.ttfbMs ?? ''}</td>
        <td>${escapeHtml((page.schemaTypes || []).join(', '))}</td>
      </tr>`).join('')}
    </tbody>
  `;
}

async function renderTemplates(runId) {
  const payload = await fetchJson(`/api/audits/${runId}/templates`);
  const rows = payload.templates || [];
  const table = document.querySelector('#templates');
  if (!rows.length) {
    table.innerHTML = '<tbody><tr><td class="muted">Noch keine Template-Cluster.</td></tr></tbody>';
    return;
  }
  table.innerHTML = `
    <thead><tr>
      <th>Cluster</th><th>Type</th><th>Pattern</th><th>URLs</th><th>Indexable</th><th>Status</th><th>Schema</th><th>Avg Words</th><th>Samples</th>
    </tr></thead>
    <tbody>
      ${rows.map((row) => `<tr>
        <td>${escapeHtml(row.clusterKey)}</td>
        <td>${escapeHtml(row.pageType || '')}</td>
        <td>${escapeHtml(row.urlPattern || '')}</td>
        <td>${row.urlCount ?? 0}</td>
        <td>${row.indexableCount ?? 0}</td>
        <td>${escapeHtml(formatObjectSummary(row.statusCodeSummary))}</td>
        <td>${escapeHtml(formatObjectSummary(row.schemaTypesSummary))}</td>
        <td>${row.avgWordCount ?? ''}</td>
        <td>${escapeHtml((row.sampleUrls || []).join('\\n'))}</td>
      </tr>`).join('')}
    </tbody>
  `;
}

async function renderTemplatePerformance(runId) {
  const payload = await fetchJson(`/api/audits/${runId}/template-performance?limit=200`);
  const rows = payload.templates || [];
  const table = document.querySelector('#template-performance');
  if (!rows.length) {
    table.innerHTML = '<tbody><tr><td class="muted">Keine Template-Performance-Daten. Playwright/Lighthouse kann deaktiviert oder nicht verfügbar sein.</td></tr></tbody>';
    return;
  }
  table.innerHTML = `
    <thead><tr>
      <th>Template</th><th>Samples</th><th>Avg Perf</th><th>Min Perf</th><th>Avg SEO</th><th>Avg LCP</th><th>Avg TBT</th><th>Avg CLS</th><th>JS Required</th><th>Console Errors</th><th>Worst Samples</th>
    </tr></thead>
    <tbody>
      ${rows.map((row) => `<tr>
        <td>${escapeHtml(row.templateClusterKey || '')}</td>
        <td>${row.sampleCount ?? 0}</td>
        <td>${formatScore(row.avgPerformanceScore)}</td>
        <td>${formatScore(row.minPerformanceScore)}</td>
        <td>${formatScore(row.avgSeoScore)}</td>
        <td>${formatMs(row.avgLcpMs)}</td>
        <td>${formatMs(row.avgTbtMs)}</td>
        <td>${row.avgCls ?? ''}</td>
        <td>${row.jsRequiredCount ?? 0}</td>
        <td>${row.consoleErrorSampleCount ?? 0}</td>
        <td>${escapeHtml((row.worstSampleUrls || []).map((sample) => sample.url || sample).join('\\n'))}</td>
      </tr>`).join('')}
    </tbody>
  `;
}

function metric(label, value) {
  return `<div class="stat-card metric"><span class="label">${label}</span><strong class="value">${value}</strong></div>`;
}

function score(label, value) {
  return `<div class="stat-card metric accent"><span class="label">${label}</span><strong class="value score">${value === null || value === undefined ? 'NA' : `${value}%`}</strong></div>`;
}

function exportLinks(runId) {
  const exports = [
    ['Findings CSV', 'findings'],
    ['URL Inventory CSV', 'pages'],
    ['Links CSV', 'links'],
    ['Images CSV', 'images'],
    ['Resources CSV', 'resources'],
    ['Schemas CSV', 'schemas'],
    ['GEO Signals CSV', 'geo-signals'],
    ['Reviews CSV', 'reviews'],
    ['Samples CSV', 'samples'],
    ['Playwright Results CSV', 'playwright-results'],
    ['Lighthouse Results CSV', 'lighthouse-results'],
    ['Template Performance CSV', 'template-performance'],
    ['Templates CSV', 'templates'],
    ['Status Summary CSV', 'status-summary']
  ];
  return `<div class="actions">${exports.map(([label, type]) => `<a class="button secondary" href="/api/audits/${runId}/export/${type}.csv">${label}</a>`).join('')}</div>`;
}

function populateSelect(selector, values) {
  const select = document.querySelector(selector);
  select.innerHTML += values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
}

function structureSignals(page) {
  return [
    page.hasTables ? 'tables' : '',
    page.hasLists ? 'lists' : '',
    page.hasFaqPattern ? 'faq' : '',
    page.hasVisibleDate ? 'date' : '',
    page.hasAuthorPattern ? 'author' : '',
    page.externalSourceLinksCount ? `sources:${page.externalSourceLinksCount}` : '',
    page.hasVideoEmbed ? 'video' : ''
  ].filter(Boolean).join(', ');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function formatObjectSummary(value) {
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value).map(([key, count]) => `${key}:${count}`).join(', ');
}

function formatScore(value) {
  return value === null || value === undefined || value === '' ? '' : `${Math.round(Number(value) * 100)}%`;
}

function scoreLabel(value) {
  return value === null || value === undefined || value === '' ? 'NA' : `${value}%`;
}

function formatSigned(value) {
  if (value === null || value === undefined || value === '') return 'NA';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return number > 0 ? `+${number}` : String(number);
}

function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join('\n');
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function formatMs(value) {
  return value === null || value === undefined || value === '' ? '' : `${Math.round(Number(value))}ms`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || response.statusText);
  return payload;
}

function clearPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function formatSeconds(seconds) {
  seconds = Number(seconds || 0);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

function formatDateTime(value) {
  if (!value) return 'NA';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('de-DE', {
    dateStyle: 'short',
    timeStyle: 'short'
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function truncateText(value, maxLength) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(String(value));
  return String(value).replace(/["\\]/g, '\\$&');
}
