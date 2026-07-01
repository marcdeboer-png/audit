import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('..', import.meta.url);

test('OMfire logo assets were extracted from the reference HTML', () => {
  const light = fs.readFileSync(new URL('../src/public/assets/omfire-logo-light.png', import.meta.url));
  const dark = fs.readFileSync(new URL('../src/public/assets/omfire-logo-dark.png', import.meta.url));

  assert.equal(light.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(dark.subarray(1, 4).toString('ascii'), 'PNG');
  assert.ok(light.length > 5000);
  assert.ok(dark.length > 5000);
});

test('App shell uses OMfire branding, theme toggle and local assets without external fonts', () => {
  const index = read('src/public/index.html');
  const app = read('src/public/app.js');
  const css = read('src/public/styles.css');
  const combined = `${index}\n${app}\n${css}`;

  assert.match(index, /<html lang="de" data-theme="light">/);
  assert.match(index, /OMfire! SEO & GEO Audit|SEO &amp; GEO Audit/);
  assert.match(index, /assets\/omfire-logo-light\.png/);
  assert.match(index, /assets\/omfire-logo-dark\.png/);
  assert.match(index, /id="theme-toggle"/);
  assert.match(app, /omfire-audit-theme/);
  assert.match(app, /Full Audit starten/);
  assert.match(app, /value="full" checked/);
  assert.match(css, /--red:\s*#E5001C/);
  assert.match(css, /--bg:\s*#F7F7F5/);
  assert.match(css, /html\[data-theme="dark"\]/);
  assert.match(css, /\.stat-card/);
  assert.match(css, /\.header-tag/);
  assert.doesNotMatch(combined, /fonts\.googleapis|fonts\.gstatic|cdn\./i);
  assert.doesNotMatch(combined, /Interhyp/i);
});

test('Results workspace keeps audit exports and secondary areas in branded card workflow', () => {
  const app = read('src/public/app.js');
  const css = read('src/public/styles.css');

  assert.match(app, /Audit Workspace/);
  assert.match(app, /Full Audit Export ZIP/);
  assert.match(app, /Full Audit JSON/);
  assert.match(app, /download="audit-\$\{runId\}-full-audit\.zip"/);
  assert.match(app, /download="audit-\$\{runId\}-full-audit\.json"/);
  assert.match(app, /Weitere CSV-Exports/);
  assert.match(app, /Reports & Verlauf/);
  assert.match(app, /Details ansehen/);
  assert.match(app, /Prüfpunkt exportieren/);
  assert.match(css, /\.check-card-ToDo/);
  assert.match(css, /\.check-card-Opportunity/);
  assert.match(css, /\.modal-card/);
  assert.doesNotMatch(app, /class="panel export-panel"/);
});

test('Static HTML report template contains OMfire branding and no copied Interhyp content', () => {
  const report = read('src/reports/reportGenerator.js');

  assert.match(report, /OMfire! Audit Report Run/);
  assert.match(report, /assets\/omfire-logo-light\.png/);
  assert.match(report, /SEO &amp; GEO Audit/);
  assert.match(report, /Full Audit ZIP/);
  assert.match(report, /Full Audit JSON/);
  assert.match(report, /--red:#E5001C/);
  assert.match(report, /--surface:#FFFFFF/);
  assert.doesNotMatch(report, /fonts\.googleapis|fonts\.gstatic|cdn\./i);
  assert.doesNotMatch(report, /Interhyp/i);
});

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, root), 'utf8');
}
