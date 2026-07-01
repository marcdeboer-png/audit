export const STORAGE_PROFILE_NAMES = ['lean', 'standard', 'debug'];

export const STORAGE_PROFILES = Object.freeze({
  lean: Object.freeze({
    storageProfile: 'lean',
    storeRawHtml: false,
    storeRenderedHtml: false,
    storeResponseHeaders: true,
    storeAllLinks: false,
    storeAllImages: false,
    storeAllResources: false,
    storeAffectedOnlyDetails: true,
    maxEvidenceSamplesPerCheck: 10,
    maxStoredDetailRowsPerCheck: 250,
    maxRawHtmlBytesPerUrl: 0
  }),
  standard: Object.freeze({
    storageProfile: 'standard',
    storeRawHtml: false,
    storeRenderedHtml: false,
    storeResponseHeaders: true,
    storeAllLinks: true,
    storeAllImages: true,
    storeAllResources: true,
    storeAffectedOnlyDetails: false,
    maxEvidenceSamplesPerCheck: 20,
    maxStoredDetailRowsPerCheck: 1000,
    maxRawHtmlBytesPerUrl: 0
  }),
  debug: Object.freeze({
    storageProfile: 'debug',
    storeRawHtml: true,
    storeRenderedHtml: true,
    storeResponseHeaders: true,
    storeAllLinks: true,
    storeAllImages: true,
    storeAllResources: true,
    storeAffectedOnlyDetails: false,
    maxEvidenceSamplesPerCheck: 50,
    maxStoredDetailRowsPerCheck: 10000,
    maxRawHtmlBytesPerUrl: 250000
  })
});

const BOOLEAN_STORAGE_FIELDS = [
  'storeRawHtml',
  'storeRenderedHtml',
  'storeResponseHeaders',
  'storeAllLinks',
  'storeAllImages',
  'storeAllResources',
  'storeAffectedOnlyDetails'
];

const INTEGER_STORAGE_FIELDS = [
  'maxEvidenceSamplesPerCheck',
  'maxStoredDetailRowsPerCheck',
  'maxRawHtmlBytesPerUrl'
];

export function normalizeStorageProfile(value) {
  const text = String(value || '').trim().toLowerCase();
  return STORAGE_PROFILE_NAMES.includes(text) ? text : 'standard';
}

export function deriveCrawlScaleMode(maxUrls) {
  const value = Math.max(1, Number(maxUrls || 1));
  if (value <= 500) return 'small';
  if (value <= 5000) return 'medium';
  if (value <= 50000) return 'large';
  return 'enterprise';
}

export function normalizeCrawlScaleMode(value, maxUrls) {
  const text = String(value || '').trim().toLowerCase();
  return ['small', 'medium', 'large', 'enterprise'].includes(text)
    ? text
    : deriveCrawlScaleMode(maxUrls);
}

export function normalizeStorageConfig(input = {}) {
  const profileName = normalizeStorageProfile(input.storageProfile);
  const profile = STORAGE_PROFILES[profileName];
  const output = {
    storageProfile: profileName
  };

  for (const field of BOOLEAN_STORAGE_FIELDS) {
    output[field] = coerceBoolean(input[field], profile[field]);
  }
  for (const field of INTEGER_STORAGE_FIELDS) {
    output[field] = boundedInteger(input[field], profile[field], field);
  }

  return output;
}

export function normalizeEnterpriseConfig(input = {}) {
  const maxUrls = Math.max(1, Number(input.maxUrls || 1));
  const storage = normalizeStorageConfig(input);
  const crawlScaleMode = normalizeCrawlScaleMode(input.crawlScaleMode, maxUrls);
  const estimate = estimateStorage({
    ...input,
    ...storage,
    maxUrls,
    crawlScaleMode
  });
  return {
    ...storage,
    crawlScaleMode,
    storageEstimate: estimate,
    storageEstimateJson: JSON.stringify(estimate)
  };
}

export function estimateStorage(input = {}) {
  const maxUrls = Math.max(1, Number(input.maxUrls || 1));
  const profile = normalizeStorageProfile(input.storageProfile);
  const scaleMode = normalizeCrawlScaleMode(input.crawlScaleMode, maxUrls);
  const storeRawHtml = coerceBoolean(input.storeRawHtml, STORAGE_PROFILES[profile].storeRawHtml);
  const storeRenderedHtml = coerceBoolean(input.storeRenderedHtml, STORAGE_PROFILES[profile].storeRenderedHtml);
  const storeAllLinks = coerceBoolean(input.storeAllLinks, STORAGE_PROFILES[profile].storeAllLinks);
  const storeAllImages = coerceBoolean(input.storeAllImages, STORAGE_PROFILES[profile].storeAllImages);
  const storeAllResources = coerceBoolean(input.storeAllResources, STORAGE_PROFILES[profile].storeAllResources);
  const maxRawHtmlBytesPerUrl = boundedInteger(
    input.maxRawHtmlBytesPerUrl,
    STORAGE_PROFILES[profile].maxRawHtmlBytesPerUrl,
    'maxRawHtmlBytesPerUrl'
  );

  let bytesPerUrl = 1400;
  if (storeAllLinks) bytesPerUrl += profile === 'debug' ? 2200 : 450;
  if (storeAllImages) bytesPerUrl += 1800;
  if (storeAllResources) bytesPerUrl += 2600;
  if (coerceBoolean(input.storeResponseHeaders, STORAGE_PROFILES[profile].storeResponseHeaders)) bytesPerUrl += 500;
  if (storeRawHtml) bytesPerUrl += Math.max(5000, maxRawHtmlBytesPerUrl || 100000);
  if (storeRenderedHtml) bytesPerUrl += Math.max(5000, Math.round((maxRawHtmlBytesPerUrl || 100000) * 0.8));

  const estimatedBytes = Math.round(bytesPerUrl * maxUrls);
  const estimatedMb = Number((estimatedBytes / 1024 / 1024).toFixed(1));
  const warnings = [];
  if (profile === 'debug' && maxUrls > 5000) {
    warnings.push('Debug Storage mit mehr als 5.000 URLs kann sehr groß werden. Verwende debug nur für kleine oder gezielte Runs.');
  }
  if ((storeRawHtml || storeRenderedHtml) && maxUrls > 5000) {
    warnings.push('Raw-/Rendered-HTML-Snapshots sind aktiv und skalieren linear mit der URL-Anzahl.');
  }
  if (scaleMode === 'large' || scaleMode === 'enterprise') {
    if (input.playwrightMode === 'all') {
      warnings.push('Large/Enterprise Mode: Playwright all ist riskant. Playwright sample ist empfohlen.');
    }
    if (coerceBoolean(input.enableLighthouseSampling, false) && Number(input.maxTemplateSamplesTotal || 0) > 200) {
      warnings.push('Large/Enterprise Mode: Lighthouse sollte auf wenige Template-Samples begrenzt bleiben.');
    }
  }
  if (profile === 'lean') {
    warnings.push('Lean Storage speichert keine vollständigen Link-/Image-/Resource-Detailtabellen; einige Detailansichten können nur aggregierte Facts zeigen.');
  }

  return {
    profile,
    crawlScaleMode: scaleMode,
    maxUrls,
    estimatedBytes,
    estimatedMb,
    roughSizeLabel: sizeLabel(estimatedMb),
    riskLevel: riskLevel(estimatedMb, warnings.length),
    recommendedStorageProfile: scaleMode === 'enterprise' ? 'lean' : profile === 'debug' && maxUrls > 5000 ? 'standard' : profile,
    recommendedPlaywrightMode: scaleMode === 'large' || scaleMode === 'enterprise' ? 'sample' : input.playwrightMode || 'off',
    warnings
  };
}

export function storageProfileSummary(profileName) {
  const profile = STORAGE_PROFILES[normalizeStorageProfile(profileName)];
  return {
    ...profile,
    description: profile.storageProfile === 'lean'
      ? 'Aggregierte URL-Facts, keine Raw-HTML-Blobs und keine vollständigen Artefaktlisten.'
      : profile.storageProfile === 'debug'
        ? 'Zusätzliche Raw-/Rendered-HTML-Snapshots und umfangreichere Evidence für kleine Debug-Runs.'
        : 'URL-Facts plus normalisierte Link-/Image-/Resource-Facts mit gedeckelter Evidence.'
  };
}

function coerceBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  return Boolean(fallback);
}

function boundedInteger(value, fallback, field) {
  const number = Number(value === undefined || value === null || value === '' ? fallback : value);
  const min = field === 'maxRawHtmlBytesPerUrl' ? 0 : 1;
  const max = field === 'maxRawHtmlBytesPerUrl' ? 5 * 1024 * 1024 : field === 'maxStoredDetailRowsPerCheck' ? 50000 : 100;
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function sizeLabel(mb) {
  if (mb < 50) return 'niedrig';
  if (mb < 500) return 'mittel';
  if (mb < 5000) return 'hoch';
  return 'sehr hoch';
}

function riskLevel(mb, warningCount) {
  if (mb >= 5000 || warningCount >= 2) return 'high';
  if (mb >= 500 || warningCount) return 'medium';
  return 'low';
}
