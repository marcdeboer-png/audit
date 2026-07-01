import fs from 'node:fs';
import process from 'node:process';
import { createRequire } from 'node:module';
import { inspectLighthouseRuntime } from './lighthouseRuntime.js';

const require = createRequire(import.meta.url);
const PACKAGE_JSON_URL = new URL('../../package.json', import.meta.url);

export async function getCapabilities() {
  const node = {
    ok: true,
    version: process.version
  };
  const playwrightPackage = packageAvailable('@playwright/test');
  const chromium = await chromiumAvailable(playwrightPackage.available);
  const lighthouseRuntime = await inspectLighthouseRuntime();
  const lighthousePackage = packageCapability('lighthouse', lighthouseRuntime.lighthouse);
  const chromeLauncherPackage = packageCapability('chrome-launcher', lighthouseRuntime.chromeLauncher);
  const lighthouseSampling = {
    available: lighthouseRuntime.usable,
    usable: lighthouseRuntime.usable,
    reason: lighthouseRuntime.reason,
    fix: lighthouseRuntime.fix,
    lighthousePackage,
    chromeLauncherPackage
  };
  const zipExport = {
    available: true,
    label: 'Built-in stored ZIP export'
  };
  const hints = [
    !playwrightPackage.available ? hint('Playwright package unavailable', 'npm install @playwright/test') : null,
    playwrightPackage.available && !chromium.available ? hint('Chromium not installed', 'npx playwright install chromium') : null,
    !lighthousePackage.importable ? hint(lighthousePackage.reason || 'Lighthouse package is not installed or not importable', 'npm install lighthouse chrome-launcher') : null,
    !chromeLauncherPackage.importable ? hint(chromeLauncherPackage.reason || 'chrome-launcher package is not installed or not importable', 'npm install lighthouse chrome-launcher') : null
  ].filter(Boolean);
  const browserReady = playwrightPackage.available && chromium.available;
  const fullAuditAvailable = browserReady && lighthouseSampling.available;
  const fullAuditMode = {
    available: fullAuditAvailable,
    availableWithWarnings: browserReady && !lighthouseSampling.available,
    degraded: !fullAuditAvailable,
    notes: hints.map((item) => item.message),
    lighthouseSampling
  };

  return {
    node,
    playwrightPackage,
    chromium,
    lighthousePackage,
    chromeLauncherPackage,
    lighthouseSampling,
    zipExport,
    fullAuditMode,
    fullAudit: fullAuditMode,
    llmProviders: {
      none: { available: true, sendsExternalData: false },
      openai: { available: Boolean(process.env.OPENAI_API_KEY), envKey: 'OPENAI_API_KEY', sendsExternalData: true },
      anthropic: { available: Boolean(process.env.ANTHROPIC_API_KEY), envKey: 'ANTHROPIC_API_KEY', sendsExternalData: true }
    },
    hints
  };
}

function packageAvailable(name) {
  try {
    return {
      available: true,
      declared: packageDeclared(name),
      resolvable: true,
      importable: true,
      path: require.resolve(name)
    };
  } catch (error) {
    return {
      available: false,
      declared: packageDeclared(name),
      resolvable: false,
      importable: false,
      reason: packageReason(error)
    };
  }
}

function packageDeclared(name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_URL, 'utf8'));
    return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name] || pkg.optionalDependencies?.[name]);
  } catch {
    return false;
  }
}

function packageCapability(name, inspected) {
  return {
    name,
    available: Boolean(inspected.importable),
    declared: Boolean(inspected.declared),
    resolvable: Boolean(inspected.resolvable),
    importable: Boolean(inspected.importable),
    path: inspected.path || null,
    reason: inspected.reason || null,
    fix: inspected.fix || null
  };
}

async function chromiumAvailable(playwrightAvailable) {
  if (!playwrightAvailable) {
    return {
      available: false,
      reason: 'Playwright package unavailable'
    };
  }
  try {
    const { chromium } = await import('@playwright/test');
    const executablePath = chromium.executablePath();
    return {
      available: fs.existsSync(executablePath),
      executablePath,
      reason: fs.existsSync(executablePath) ? null : 'Chromium executable not found'
    };
  } catch (error) {
    return {
      available: false,
      reason: error.message
    };
  }
}

function packageReason(error) {
  const message = error?.message || String(error || 'unavailable');
  if (/Cannot find module|Cannot find package/i.test(message)) return 'package not installed';
  return message;
}

function hint(message, fix) {
  return { message, fix };
}
