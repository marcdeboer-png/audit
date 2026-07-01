import {
  lighthouseSetupFix,
  loadLighthouseRuntime,
  shortLighthouseUnavailableReason
} from '../runtime/lighthouseRuntime.js';

export async function createLighthouseSampler({
  device = 'mobile',
  categories = ['performance', 'accessibility', 'best-practices', 'seo'],
  timeoutMs = 60000,
  log = null,
  forceUnavailable = false
} = {}) {
  const runtime = await loadLighthouseRuntime({ forceUnavailable });
  if (!runtime.usable) {
    const reason = shortLighthouseUnavailableReason(runtime.reason);
    const fix = lighthouseSetupFix(reason);
    if (log) log('warning', 'Lighthouse template sampling unavailable', { reason, fix });
    return {
      available: false,
      unavailableReason: reason,
      fix,
      async close() {},
      async sample() {
        return unavailableResult(device, reason, fix);
      }
    };
  }

  const lighthouse = runtime.lighthouseModule.default || runtime.lighthouseModule;
  const chromeLauncher = runtime.chromeLauncherModule;

  let chrome;
  try {
    chrome = await chromeLauncher.launch({
      chromeFlags: ['--headless=new', '--disable-gpu', '--no-sandbox']
    });
  } catch (error) {
    const reason = shortLighthouseUnavailableReason(error, 'Chromium/Chrome could not be launched for Lighthouse');
    const fix = lighthouseSetupFix(reason);
    if (log) log('warning', 'Lighthouse Chrome launcher unavailable', { reason, fix });
    return {
      available: false,
      unavailableReason: reason,
      fix,
      async close() {},
      async sample() {
        return unavailableResult(device, reason, fix);
      }
    };
  }

  return {
    available: true,
    unavailableReason: null,
    async close() {
      await Promise.resolve(chrome.kill()).catch(() => {});
    },
    async sample(sample) {
      return sampleWithLighthouse(lighthouse, chrome.port, sample.url, {
        device,
        categories,
        timeoutMs
      });
    }
  };
}

async function sampleWithLighthouse(lighthouse, port, url, options) {
  try {
    const categories = normalizeLighthouseCategories(options.categories);
    const result = await withTimeout(lighthouse(url, {
      port,
      output: 'json',
      logLevel: 'error',
      ...(categories.length ? { onlyCategories: categories } : {}),
      ...lighthouseFlags(options)
    }), options.timeoutMs);
    const lhr = result?.lhr;
    if (!lhr) throw new Error('Lighthouse returned no report');
    const audits = lhr.audits || {};
    return {
      device: options.device,
      performanceScore: score(lhr.categories?.performance?.score),
      accessibilityScore: score(lhr.categories?.accessibility?.score),
      bestPracticesScore: score(lhr.categories?.['best-practices']?.score),
      seoScore: score(lhr.categories?.seo?.score),
      firstContentfulPaintMs: metric(audits['first-contentful-paint']),
      largestContentfulPaintMs: metric(audits['largest-contentful-paint']),
      totalBlockingTimeMs: metric(audits['total-blocking-time']),
      cumulativeLayoutShift: metric(audits['cumulative-layout-shift']),
      speedIndexMs: metric(audits['speed-index']),
      interactiveMs: metric(audits.interactive),
      totalByteWeight: metric(audits['total-byte-weight']),
      domSize: metric(audits['dom-size']),
      auditsJson: JSON.stringify(compactAudits(audits)),
      errorMessage: null
    };
  } catch (error) {
    const reason = shortLighthouseUnavailableReason(error, firstLine(error?.message || 'Lighthouse run failed'));
    return {
      device: options.device,
      performanceScore: null,
      accessibilityScore: null,
      bestPracticesScore: null,
      seoScore: null,
      firstContentfulPaintMs: null,
      largestContentfulPaintMs: null,
      totalBlockingTimeMs: null,
      cumulativeLayoutShift: null,
      speedIndexMs: null,
      interactiveMs: null,
      totalByteWeight: null,
      domSize: null,
      auditsJson: JSON.stringify({ error: reason }),
      errorMessage: reason
    };
  }
}

function lighthouseFlags(options) {
  if (options.device === 'desktop') {
    return {
      formFactor: 'desktop',
      screenEmulation: {
        mobile: false,
        width: 1350,
        height: 940,
        deviceScaleFactor: 1,
        disabled: false
      }
    };
  }
  return {
    formFactor: 'mobile'
  };
}

function normalizeLighthouseCategories(categories = []) {
  const allowed = new Set(['performance', 'accessibility', 'best-practices', 'seo']);
  const aliases = new Map([
    ['best_practices', 'best-practices'],
    ['best practices', 'best-practices'],
    ['best-practice', 'best-practices']
  ]);
  return [...new Set((Array.isArray(categories) ? categories : [])
    .map((category) => String(category || '').trim().toLowerCase())
    .map((category) => aliases.get(category) || category)
    .filter((category) => allowed.has(category)))];
}

function score(value) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(3)) : null;
}

function metric(audit) {
  const value = audit?.numericValue;
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(3)) : null;
}

function compactAudits(audits) {
  const important = [
    'first-contentful-paint',
    'largest-contentful-paint',
    'total-blocking-time',
    'cumulative-layout-shift',
    'speed-index',
    'interactive',
    'total-byte-weight',
    'dom-size',
    'render-blocking-resources',
    'unused-javascript',
    'uses-responsive-images'
  ];
  const output = {};
  for (const id of important) {
    if (!audits[id]) continue;
    output[id] = {
      score: score(audits[id].score),
      numericValue: metric(audits[id]),
      displayValue: audits[id].displayValue || null
    };
  }
  return output;
}

function unavailableResult(device, reason, fix = null) {
  return {
    device,
    performanceScore: null,
    accessibilityScore: null,
    bestPracticesScore: null,
    seoScore: null,
    firstContentfulPaintMs: null,
    largestContentfulPaintMs: null,
    totalBlockingTimeMs: null,
    cumulativeLayoutShift: null,
    speedIndexMs: null,
    interactiveMs: null,
    totalByteWeight: null,
    domSize: null,
    auditsJson: JSON.stringify({ unavailable: { reason, fix } }),
    errorMessage: reason
  };
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Lighthouse timed out after ${timeoutMs}ms`)), timeoutMs))
  ]);
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/)[0] || '';
}
