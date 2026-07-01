import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPageType } from '../src/extractors/pageType.js';

test('detects page types from URL, schema, title and headings', () => {
  assert.equal(detectPageType({ url: 'https://example.com/' }), 'homepage');
  assert.equal(detectPageType({ url: 'https://example.com/blog/seo-guide', schemaTypes: ['Article'] }), 'article');
  assert.equal(detectPageType({ url: 'https://example.com/shop/widgets/widget-a', schemaTypes: ['Product'] }), 'product');
  assert.equal(detectPageType({ url: 'https://example.com/p/product-name-123' }), 'product');
  assert.equal(detectPageType({ url: 'https://example.com/c/katze/futter' }), 'category');
  assert.equal(detectPageType({ url: 'https://example.com/stores/fressnapf-berlin' }), 'location');
  assert.equal(detectPageType({ url: 'https://example.com/kategorie/widgets', title: 'Widget Kategorie' }), 'category');
  assert.equal(detectPageType({ url: 'https://example.com/standorte/berlin', h1: ['Standort Berlin'] }), 'location');
  assert.equal(detectPageType({ url: 'https://example.com/impressum', title: 'Impressum' }), 'legal');
  assert.equal(detectPageType({ url: 'https://example.com/kontakt', title: 'Kontakt' }), 'contact');
});
