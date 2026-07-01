import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PACKAGE_JSON_URL = new URL('../../package.json', import.meta.url);
const LIGHTHOUSE_FIX = 'npm install lighthouse chrome-launcher';
const CHROMIUM_FIX = 'Install a local Chrome/Chromium browser for Lighthouse, or run npx playwright install chromium.';

export async function inspectLighthouseRuntime(options = {}) {
  const {
    lighthouseModuleName = 'lighthouse',
    chromeLauncherModuleName = 'chrome-launcher',
    forceUnavailable = false
  } = options;
  const lighthouse = await inspectNodePackage(lighthouseModuleName, {
    displayName: 'Lighthouse package',
    fix: LIGHTHOUSE_FIX,
    skipImport: forceUnavailable,
    forcedReason: forceUnavailable ? 'Lighthouse package is not installed or not importable' : null
  });
  const chromeLauncher = await inspectNodePackage(chromeLauncherModuleName, {
    displayName: 'chrome-launcher package',
    fix: LIGHTHOUSE_FIX,
    skipImport: forceUnavailable,
    forcedReason: forceUnavailable ? 'chrome-launcher package is not installed or not importable' : null
  });
  const usable = !forceUnavailable && lighthouse.importable && chromeLauncher.importable;
  const reason = usable ? null : firstReason([
    lighthouse.reason,
    chromeLauncher.reason,
    forceUnavailable ? 'Lighthouse package is not installed or not importable' : null
  ]);
  return {
    available: usable,
    usable,
    reason,
    fix: usable ? null : LIGHTHOUSE_FIX,
    lighthouse,
    chromeLauncher
  };
}

export async function loadLighthouseRuntime(options = {}) {
  const inspected = await inspectLighthouseRuntime(options);
  return {
    ...inspected,
    lighthouseModule: inspected.lighthouse.module,
    chromeLauncherModule: inspected.chromeLauncher.module
  };
}

export function shortLighthouseUnavailableReason(error, fallback = 'Lighthouse package is not installed or not importable') {
  const message = String(error?.message || error || fallback);
  if (/cannot find package|cannot find module|module_not_found|err_module_not_found|not importable|not installed|forced/i.test(message)) {
    return fallback;
  }
  if (/chrome|chromium|executable|launcher/i.test(message)) {
    return 'Chromium/Chrome could not be launched for Lighthouse';
  }
  return firstLine(message).slice(0, 240);
}

export function lighthouseSetupFix(reason = '') {
  return /chrom(e|ium)|launcher|executable/i.test(String(reason)) && !/package|module|importable|installed/i.test(String(reason))
    ? CHROMIUM_FIX
    : LIGHTHOUSE_FIX;
}

async function inspectNodePackage(name, { displayName, fix, skipImport = false, forcedReason = null }) {
  const declared = packageDeclared(name);
  let resolvedPath = null;
  let resolvable = false;
  let importable = false;
  let reason = forcedReason;
  let module = null;

  if (!skipImport) {
    try {
      resolvedPath = require.resolve(name);
      resolvable = true;
    } catch (error) {
      reason = normalizePackageReason(error, `${displayName} is not installed or not importable`);
    }

    if (resolvable) {
      try {
        module = await import(name);
        importable = true;
      } catch (error) {
        reason = normalizePackageReason(error, `${displayName} is not installed or not importable`);
      }
    }
  }

  return {
    available: importable,
    declared,
    resolvable,
    importable,
    path: resolvedPath,
    reason: importable ? null : reason || `${displayName} is not installed or not importable`,
    fix,
    module
  };
}

function packageDeclared(name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_URL, 'utf8'));
    return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name] || pkg.optionalDependencies?.[name]);
  } catch {
    return false;
  }
}

function normalizePackageReason(error, fallback) {
  const message = String(error?.message || error || fallback);
  if (/cannot find package|cannot find module|module_not_found|err_module_not_found/i.test(message)) return fallback;
  return firstLine(message).slice(0, 240);
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/)[0] || '';
}

function firstReason(reasons) {
  return reasons.find((reason) => reason && String(reason).trim()) || null;
}
