import http from 'node:http';

export async function startFixtureSite(kind, options = {}) {
  const server = http.createServer((req, res) => {
    const host = `http://${req.headers.host}`;
    const url = new URL(req.url || '/', host);
    routeFixture(kind, options, url, res, host);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    domain: `127.0.0.1:${server.address().port}`,
    url(path = '/') {
      return `${origin}${path}`;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

function routeFixture(kind, options, url, res, host) {
  if (url.pathname === '/robots.txt') return robots(res, host, kind, options);
  if (url.pathname === '/sitemap.xml') return sitemap(res, host, sitemapPaths(kind, options));
  if (url.pathname === '/llms.txt') return llmsTxt(res, host, kind, options);
  if (url.pathname === '/llms-full.txt') return llmsFullTxt(res, kind, options);
  if (['/index.md', '/index.md.txt', '/README.md'].includes(url.pathname)) return markdownTwin(res, kind);
  if (url.pathname.startsWith('/assets/')) return asset(res, url.pathname);

  switch (kind) {
    case 'clean':
      return cleanRoute(res, host, url.pathname);
    case 'seo':
      return seoRoute(res, host, url.pathname);
    case 'media':
      return mediaRoute(res, host, url.pathname);
    case 'schema':
      return schemaRoute(res, host, url.pathname);
    case 'geo':
      return geoRoute(res, host, url.pathname, options);
    case 'rendering':
      return renderingRoute(res, host, url.pathname);
    default:
      return notFound(res, host, url.pathname);
  }
}

function cleanRoute(res, host, pathname) {
  if (pathname === '/article/guide') {
    return html(res, host, pathname, {
      title: 'Clean Site Article Guide For Testing',
      description: 'A deterministic article page with valid metadata, schema, breadcrumbs, images and internal links.',
      pageType: 'article',
      body: `
        <nav aria-label="Breadcrumb"><a href="/">Home</a> <span>Guide</span></nav>
        <article>
          <h1>Clean Site Article Guide</h1>
          <p class="byline">Written by Fixture Author on 2026-02-01.</p>
          <p>This article provides stable fixture content with enough words for extraction checks and clear structure.</p>
          <ul><li>Structured point one</li><li>Structured point two</li></ul>
          <img src="/assets/clean-article.webp" alt="Clean article diagram" width="640" height="360" loading="lazy">
        </article>
      `,
      schema: [
        schema('Article', { headline: 'Clean Site Article Guide', author: { '@type': 'Person', name: 'Fixture Author' } }),
        breadcrumbSchema(host, ['/article/guide'])
      ]
    });
  }
  if (pathname === '/category/tools') {
    return html(res, host, pathname, {
      title: 'Clean Site Tools Category Overview',
      description: 'A deterministic category page with valid title, description, canonical, breadcrumb schema and links.',
      pageType: 'category',
      body: `
        <nav aria-label="Breadcrumb"><a href="/">Home</a> <span>Tools</span></nav>
        <h1>Tools Category</h1>
        <p>Category page with useful internal links and a visible update date 2026-02-02.</p>
        <a href="/article/guide">Guide</a>
        <img src="/assets/category.png" alt="Tools category thumbnail" width="320" height="180" loading="lazy">
      `,
      schema: [breadcrumbSchema(host, ['/category/tools'])]
    });
  }
  return html(res, host, '/', {
    title: 'Clean Fixture Site Home',
    description: 'A clean deterministic local fixture home page with valid SEO basics and structured data.',
    body: `
      <h1>Clean Fixture Site</h1>
      <p>Stable home content with crawlable links, a source link and valid metadata.</p>
      <a href="/article/guide">Article guide</a>
      <a href="/category/tools">Tools category</a>
      <a href="https://example.org/source-report">Source report</a>
      <img src="/assets/clean-hero.jpg" alt="Clean fixture hero" width="800" height="450" loading="lazy">
    `,
    schema: [
      schema('Organization', { name: 'Clean Fixture', sameAs: ['https://example.org/clean-fixture'] }),
      schema('WebSite', { name: 'Clean Fixture Site', url: host })
    ]
  });
}

function seoRoute(res, host, pathname) {
  const commonLinks = `
    <a href="/missing-title">Missing title</a>
    <a href="/short-title">Short title</a>
    <a href="/long-title">Long title</a>
    <a href="/missing-description">Missing description</a>
    <a href="/short-description">Short description</a>
    <a href="/long-description">Long description</a>
    <a href="/missing-h1">Missing H1</a>
    <a href="/multi-h1">Multiple H1</a>
    <a href="/canonical-other">Canonical other URL</a>
    <a href="/canonical-404">Canonical 404</a>
    <a href="/canonical-external">Canonical external</a>
    <a href="/content-noindex">Content noindex</a>
    <a href="/legal-noindex">Legal noindex</a>
    <a href="/broken-link-source">Broken link source</a>
  `;
  if (pathname === '/') {
    return html(res, host, pathname, {
      title: 'SEO Issues Fixture Home Page',
      description: 'A deterministic SEO issue fixture index page linking to controlled problem URLs.',
      body: `<h1>SEO Issues Fixture</h1>${commonLinks}`
    });
  }
  if (pathname === '/missing-title') return html(res, host, pathname, { title: '', body: '<h1>Missing Title Page</h1>' });
  if (pathname === '/short-title') return html(res, host, pathname, { title: 'Short', body: '<h1>Short Title Page</h1>' });
  if (pathname === '/long-title') return html(res, host, pathname, {
    title: 'This Fixture Title Is Deliberately Far Too Long For The Configured SEO Title Threshold',
    body: '<h1>Long Title Page</h1>'
  });
  if (pathname === '/missing-description') return html(res, host, pathname, { description: '', body: '<h1>Missing Description Page</h1>' });
  if (pathname === '/short-description') return html(res, host, pathname, { description: 'Too short.', body: '<h1>Short Description Page</h1>' });
  if (pathname === '/long-description') return html(res, host, pathname, {
    description: 'This fixture description is deliberately made much longer than the configured maximum meta description threshold so that the long description check has one deterministic affected URL and no ambiguity in the detail table output.',
    body: '<h1>Long Description Page</h1>'
  });
  if (pathname === '/missing-h1') return html(res, host, pathname, { body: '<p>This page intentionally has no primary heading.</p>' });
  if (pathname === '/multi-h1') return html(res, host, pathname, { body: '<h1>First H1</h1><h1>Second H1</h1>' });
  if (pathname === '/canonical-other') return html(res, host, pathname, { canonical: `${host}/canonical-target`, body: '<h1>Canonical Other Page</h1>' });
  if (pathname === '/canonical-404') return html(res, host, pathname, { canonical: `${host}/not-found`, body: '<h1>Canonical To 404 Page</h1>' });
  if (pathname === '/canonical-external') return html(res, host, pathname, { canonical: 'https://other.example/canonical', body: '<h1>Canonical External Page</h1>' });
  if (pathname === '/content-noindex') return html(res, host, pathname, { metaRobots: 'noindex,follow', body: '<h1>Content Noindex Page</h1>' });
  if (pathname === '/legal-noindex') return html(res, host, pathname, { metaRobots: 'noindex,follow', body: '<h1>Datenschutz</h1>' });
  if (pathname === '/broken-link-source') return html(res, host, pathname, {
    body: '<h1>Broken Link Source</h1><a href="/not-found">Broken target</a><a href="/redirect-me">Redirect target</a>'
  });
  if (pathname === '/canonical-target') return html(res, host, pathname, { body: '<h1>Canonical Target Page</h1>' });
  if (pathname === '/redirect-me') {
    res.writeHead(302, { location: `${host}/canonical-target` });
    res.end();
    return;
  }
  if (pathname === '/server-error') {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Server Error</title><h1>Server Error</h1>');
    return;
  }
  return notFound(res, host, pathname);
}

function mediaRoute(res, host, pathname) {
  return html(res, host, pathname, {
    title: 'Media Issues Fixture Page',
    description: 'A deterministic media fixture page with content, decorative, badge, icon and tracking images.',
    body: `
      <h1>Media Issues Fixture</h1>
      <p>Media page used to verify alt text, dimensions, loading and decorative image heuristics.</p>
      <img src="/assets/content-no-alt.jpg" width="640" height="360" loading="lazy">
      <img src="/assets/content-empty-alt.jpg" alt="" width="640" height="360" loading="lazy">
      <img src="/assets/decorative-divider.png" alt="" role="presentation" width="640" height="8" loading="lazy">
      <img src="/assets/trust-badge.png" alt="" class="trust-badge" width="48" height="48" loading="lazy">
      <img src="/assets/icon-search.png" alt="" class="icon" width="24" height="24" loading="lazy">
      <img src="/assets/pixel.gif" width="1" height="1">
      <img src="/assets/no-dimensions.jpg" alt="No dimensions content image" loading="lazy">
      <img src="/assets/eager-content.jpg" alt="Eager content image" width="640" height="360">
      <img src="/assets/modern-image.webp" alt="Modern WebP content image" width="640" height="360" loading="lazy">
    `
  });
}

function schemaRoute(res, host, pathname) {
  if (pathname === '/') {
    return html(res, host, pathname, {
      title: 'Schema Fixture Home Page',
      description: 'Schema fixture index page linking to article, product, location, breadcrumb and FAQ cases.',
      body: `
        <h1>Schema Fixture</h1>
        <a href="/blog/article-with-schema">Article with schema</a>
        <a href="/blog/article-without-schema">Article without schema</a>
        <a href="/blog">Blog index</a>
        <a href="/produkt/widget-with-schema">Product with schema</a>
        <a href="/produkt/widget-without-schema">Product without schema</a>
        <a href="/beratung/produktberatung">Non product advice</a>
        <a href="/standort/hamburg">Location with schema</a>
        <a href="/location/berlin">Location without schema</a>
        <a href="/invalid-jsonld">Invalid JSON-LD</a>
        <a href="/category/with-breadcrumb">Breadcrumb page</a>
        <a href="/category/missing-breadcrumb">Missing breadcrumb page</a>
        <a href="/faq-strong">Strong FAQ</a>
        <a href="/faq-weak">Weak FAQ</a>
      `,
      schema: [schema('Organization', { name: 'Schema Fixture', sameAs: ['https://example.org/schema-fixture'] }), schema('WebSite', { name: 'Schema Fixture', url: host })]
    });
  }
  if (pathname === '/blog') return html(res, host, pathname, { title: 'Schema Fixture Blog Index', body: '<h1>Blog Index</h1><p>Index page only.</p>' });
  if (pathname === '/blog/article-with-schema') return html(res, host, pathname, {
    title: 'Schema Fixture Article With Article Markup',
    body: '<article><h1>Article With Schema</h1><p class="byline">Written by Fixture Author on 2026-03-01.</p></article>',
    schema: [schema('Article', { headline: 'Article With Schema' }), breadcrumbSchema(host, [pathname])]
  });
  if (pathname === '/blog/article-without-schema') return html(res, host, pathname, {
    title: 'Schema Fixture Article Missing Article Markup',
    body: '<article><h1>Article Without Schema</h1><p class="byline">Written by Fixture Author on 2026-03-02.</p></article>',
    schema: [breadcrumbSchema(host, [pathname])]
  });
  if (pathname === '/produkt/widget-with-schema') return html(res, host, pathname, {
    title: 'Schema Fixture Product With Product Markup',
    body: '<h1>Widget With Schema</h1><p>Preis 49 Euro</p><button>In den Warenkorb</button>',
    schema: [schema('Product', { name: 'Widget With Schema' }), breadcrumbSchema(host, [pathname])]
  });
  if (pathname === '/produkt/widget-without-schema') return html(res, host, pathname, {
    title: 'Schema Fixture Product Missing Product Markup',
    body: '<h1>Widget Without Schema</h1><p>Preis 59 Euro</p><button>Add to cart</button>',
    schema: [breadcrumbSchema(host, [pathname])]
  });
  if (pathname === '/beratung/produktberatung') return html(res, host, pathname, {
    title: 'Schema Fixture Product Advice Page',
    body: '<h1>Produktberatung Without Product Intent</h1><p>This advice page mentions products but is not a sellable product page.</p>'
  });
  if (pathname === '/standort/hamburg') return html(res, host, pathname, {
    title: 'Schema Fixture Hamburg Location Page',
    body: '<h1>Standort Hamburg</h1><p>Local office details.</p>',
    schema: [schema('LocalBusiness', { name: 'Schema Fixture Hamburg' }), breadcrumbSchema(host, [pathname])]
  });
  if (pathname === '/location/berlin') return html(res, host, pathname, {
    title: 'Schema Fixture Berlin Location Page',
    body: '<h1>Location Berlin</h1><p>Local office without LocalBusiness schema.</p>',
    schema: [breadcrumbSchema(host, [pathname])]
  });
  if (pathname === '/invalid-jsonld') return html(res, host, pathname, {
    title: 'Schema Fixture Invalid JSON LD',
    body: '<h1>Invalid JSON-LD</h1>',
    rawSchemaBlocks: ['{"@context":"https://schema.org","@type":"Article",']
  });
  if (pathname === '/category/with-breadcrumb') return html(res, host, pathname, {
    title: 'Schema Fixture Category With Breadcrumb',
    body: '<h1>Category With Breadcrumb</h1>',
    schema: [breadcrumbSchema(host, [pathname])]
  });
  if (pathname === '/category/missing-breadcrumb') return html(res, host, pathname, {
    title: 'Schema Fixture Category Missing Breadcrumb',
    body: '<h1>Category Missing Breadcrumb</h1>'
  });
  if (pathname === '/faq-strong') return html(res, host, pathname, {
    title: 'Schema Fixture Strong FAQ Pattern',
    body: `
      <section class="faq">
        <h1>FAQ</h1>
        <details><summary>What is the fixture?</summary><p>A deterministic test page.</p></details>
        <details><summary>How is it used?</summary><p>It verifies FAQ schema checks.</p></details>
      </section>
    `
  });
  if (pathname === '/faq-weak') return html(res, host, pathname, {
    title: 'Schema Fixture Weak FAQ Hint',
    body: '<h1>Guide</h1><h2>What should I know?</h2><p>This is a single rhetorical section, not a full FAQ.</p>'
  });
  return notFound(res, host, pathname);
}

function geoRoute(res, host, pathname, options) {
  if (pathname === '/with-trust-links') {
    return html(res, host, pathname, {
      title: 'Geo Fixture Trust Links Present',
      description: 'GEO fixture page with crawlable trust links and maintained AI-readable candidates.',
      body: `
        <h1>Trust Links Present</h1>
        <a href="/about">About</a>
        <a href="/contact">Kontakt</a>
        <a href="/impressum">Impressum</a>
        <a href="/datenschutz">Datenschutz</a>
        <a href="/llms-full.txt">Full corpus</a>
      `
    });
  }
  if (pathname === '/without-trust-links') {
    return html(res, host, pathname, {
      title: 'Geo Fixture Missing Trust Links',
      description: 'GEO fixture page that mentions contact words in text without crawlable trust links.',
      body: '<h1>Missing Trust Links</h1><p>About, contact, impressum and datenschutz are mentioned as words only.</p>'
    });
  }
  if (['/about', '/contact', '/impressum', '/datenschutz'].includes(pathname)) {
    return html(res, host, pathname, {
      title: `Geo Fixture ${pathname.slice(1)} Page`,
      body: `<h1>${pathname.slice(1)}</h1><p>Trust page.</p>`
    });
  }
  return html(res, host, '/', {
    title: 'Geo Fixture Home Page',
    description: 'GEO fixture home page with controlled robots and llms assets.',
    body: `<h1>GEO Fixture</h1><a href="${options.trustLinks === false ? '/without-trust-links' : '/with-trust-links'}">Trust route</a>`
  });
}

function renderingRoute(res, host, pathname) {
  if (pathname === '/js-content') {
    return html(res, host, pathname, {
      title: 'Rendering Fixture JS Content Page',
      description: 'Rendering fixture page with JavaScript rendered content and a deliberate console error.',
      body: `
        <h1>Rendering Fixture</h1>
        <div id="app">Raw seed content.</div>
        <script>
          document.getElementById('app').textContent = Array.from({ length: 260 }, (_, i) => 'renderedword' + i).join(' ');
          console.error('fixture console error');
        </script>
      `
    });
  }
  return html(res, host, '/', {
    title: 'Rendering Fixture Home Page',
    description: 'Rendering fixture home linking to the JavaScript-rendered content route.',
    body: '<h1>Rendering Home</h1><a href="/js-content">JS content</a>'
  });
}

function robots(res, host, kind, options) {
  let body = `User-agent: *\nAllow: /\nSitemap: ${host}/sitemap.xml\n`;
  if (kind === 'geo' && options.explicitBots) {
    body += [
      '',
      'User-agent: GPTBot', 'Allow: /',
      'User-agent: OAI-SearchBot', 'Allow: /',
      'User-agent: ChatGPT-User', 'Allow: /',
      'User-agent: ClaudeBot', 'Allow: /',
      'User-agent: Claude-Web', 'Allow: /',
      'User-agent: PerplexityBot', 'Allow: /',
      'User-agent: Google-Extended', 'Allow: /',
      'User-agent: CCBot', 'Allow: /',
      'User-agent: Applebot', 'Allow: /',
      'User-agent: Bytespider', 'Allow: /',
      ''
    ].join('\n');
  }
  text(res, body);
}

function sitemap(res, host, paths) {
  xml(res, `<?xml version="1.0"?><urlset>${paths.map((path) => `<url><loc>${host}${path}</loc></url>`).join('')}</urlset>`);
}

function sitemapPaths(kind, options) {
  if (kind === 'clean') return ['/', '/article/guide', '/category/tools'];
  if (kind === 'seo') return ['/', '/missing-title', '/short-title', '/long-title', '/missing-description', '/short-description', '/long-description', '/missing-h1', '/multi-h1', '/canonical-other', '/canonical-404', '/canonical-external', '/content-noindex', '/legal-noindex', '/broken-link-source', '/not-found', '/canonical-target'];
  if (kind === 'media') return ['/'];
  if (kind === 'schema') return ['/', '/blog', '/blog/article-with-schema', '/blog/article-without-schema', '/produkt/widget-with-schema', '/produkt/widget-without-schema', '/beratung/produktberatung', '/standort/hamburg', '/location/berlin', '/invalid-jsonld', '/category/with-breadcrumb', '/category/missing-breadcrumb', '/faq-strong', '/faq-weak'];
  if (kind === 'geo') return ['/', options.trustLinks === false ? '/without-trust-links' : '/with-trust-links', '/about', '/contact', '/impressum', '/datenschutz'];
  if (kind === 'rendering') return ['/', '/js-content'];
  return ['/'];
}

function llmsTxt(res, host, kind, options) {
  if (kind === 'geo' && options.referenceFull) {
    return text(res, `# GEO Fixture\n\n## Resources\n- [Full corpus](${host}/llms-full.txt)\n`);
  }
  text(res, `# Local Fixture\n\n## Resources\n- [Home](${host}/)\n`);
}

function llmsFullTxt(res, kind, options) {
  const status = kind === 'geo' ? Number(options.llmsFullStatus || 404) : 404;
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(status >= 200 && status < 300 ? '# Full Fixture Corpus\n' : `llms-full status ${status}`);
}

function markdownTwin(res, kind) {
  if (kind === 'geo') return text(res, '# Markdown Twin\n\nLocal fixture twin.\n');
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

function asset(res, pathname) {
  const extension = pathname.split('.').pop().toLowerCase();
  const type = extension === 'webp' ? 'image/webp'
    : extension === 'gif' ? 'image/gif'
      : extension === 'png' ? 'image/png'
        : 'image/jpeg';
  const size = pathname.includes('large') ? 1400000 : pathname.includes('pixel') ? 43 : 2048;
  res.writeHead(200, { 'content-type': type, 'content-length': String(size), 'cache-control': 'max-age=3600' });
  res.end(Buffer.alloc(size, 0));
}

function notFound(res, host, pathname) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`not found: ${pathname}`);
}

function html(res, host, pathname, options = {}) {
  const status = options.status || 200;
  const title = options.title === undefined ? `Fixture Page ${pathname}` : options.title;
  const description = options.description === undefined
    ? 'A deterministic local fixture page with enough metadata length for stable audit tests and controlled checks.'
    : options.description;
  const canonical = options.canonical === undefined ? `${host}${pathname}` : options.canonical;
  const schemaBlocks = [
    ...(options.schema || []).map((item) => JSON.stringify({ '@context': 'https://schema.org', ...item })),
    ...(options.rawSchemaBlocks || [])
  ];
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'max-age=60',
    'content-encoding': 'identity',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'strict-transport-security': 'max-age=31536000'
  };
  res.writeHead(status, headers);
  res.end(`<!doctype html>
    <html lang="en">
      <head>
        ${title ? `<title>${escapeHtml(title)}</title>` : ''}
        ${description ? `<meta name="description" content="${escapeHtml(description)}">` : ''}
        <meta name="viewport" content="width=device-width, initial-scale=1">
        ${options.metaRobots ? `<meta name="robots" content="${escapeHtml(options.metaRobots)}">` : ''}
        ${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ''}
        <link rel="icon" href="/assets/favicon.ico">
        <link rel="manifest" href="/site.webmanifest">
        <meta property="og:title" content="${escapeHtml(title || 'Fixture Page')}">
        <meta property="og:description" content="${escapeHtml(description || 'Fixture description')}">
        <meta property="og:image" content="${host}/assets/og.jpg">
        <meta property="og:url" content="${canonical || `${host}${pathname}`}">
        ${schemaBlocks.map((raw) => `<script type="application/ld+json">${raw}</script>`).join('\n')}
      </head>
      <body>${options.body || '<h1>Fixture Page</h1><p>Fixture content.</p>'}</body>
    </html>`);
}

function schema(type, values = {}) {
  return { '@type': type, ...values };
}

function breadcrumbSchema(host, paths) {
  return schema('BreadcrumbList', {
    itemListElement: ['/', ...paths].map((path, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: index === 0 ? 'Home' : path.split('/').filter(Boolean).at(-1),
      item: `${host}${path}`
    }))
  });
}

function text(res, body) {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'max-age=60' });
  res.end(body);
}

function xml(res, body) {
  res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'max-age=60' });
  res.end(body);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
