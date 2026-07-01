import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, isLikelyHtmlPage, isInternalUrl, originCandidates } from '../src/utils/url.js';

test('normalizes URLs deterministically', () => {
  assert.equal(
    normalizeUrl('/Page/?utm_source=x&b=2&a=1#frag', 'https://Example.com/base/'),
    'https://example.com/Page?a=1&b=2'
  );
  assert.equal(normalizeUrl('mailto:test@example.com', 'https://example.com'), null);
  assert.equal(isLikelyHtmlPage('https://example.com/file.pdf'), false);
  assert.equal(isLikelyHtmlPage('https://example.com/path'), true);
  assert.equal(isInternalUrl('https://www.example.com/a', 'https://example.com'), true);
  assert.equal(
    normalizeUrl('https://example.com/path/?utm_medium=email&gclid=abc&x=1'),
    'https://example.com/path?x=1'
  );
});

test('origin candidates avoid invalid www variants for IP hosts', () => {
  assert.deepEqual(originCandidates('http://127.0.0.1:8080'), [
    'https://127.0.0.1:8080',
    'http://127.0.0.1:8080'
  ]);
});
