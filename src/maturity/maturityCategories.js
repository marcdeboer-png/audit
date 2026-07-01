export const UNCATEGORIZED_CATEGORY_ID = 'uncategorized';

export const maturityCategoryWeights = Object.freeze({
  'technical-seo': 1.2,
  'html-head': 0.8,
  'structure-quality': 1.0,
  'media-performance': 0.9,
  'structured-data': 1.3,
  'geo-readiness': 1.4,
  'ai-crawler-policy': 0.8,
  'trust-entity': 1.2,
  'security-server': 0.5,
  'template-rendering': 0.9,
  [UNCATEGORIZED_CATEGORY_ID]: 0.2
});

const maturityCategoryManagement = Object.freeze({
  'technical-seo': {
    businessImportance: 'Hoch: Grundlage für Crawl-, Indexierungs- und Signalqualität.',
    scoreInterpretation: 'Niedrige Werte zeigen operative SEO-Risiken; hohe Werte bedeuten eine belastbare technische Basis.',
    managementDescription: 'Bewertet, ob die Website für Suchmaschinen und AI-Crawler stabil erreichbar, indexierbar und intern nutzbar ist.'
  },
  'html-head': {
    businessImportance: 'Mittel: wichtig für Snippets, SERP-Verständlichkeit und Seitenklassifikation.',
    scoreInterpretation: 'Niedrige Werte weisen auf inkonsistente Seitensignale hin; hohe Werte stützen klare Themen- und Snippet-Signale.',
    managementDescription: 'Verdichtet Meta-, Head- und H1-Signale, ohne sie höher als Kern- und GEO-Signale zu gewichten.'
  },
  'structure-quality': {
    businessImportance: 'Hoch: beeinflusst maschinenlesbare Antwortfähigkeit und Zitierbarkeit.',
    scoreInterpretation: 'Niedrige Werte zeigen schwach strukturierte Inhalte; hohe Werte sprechen für gut extrahierbare Inhalte.',
    managementDescription: 'Bewertet vorhandene Strukturmerkmale wie Listen, Tabellen, Quellen, Datums- und Autorenhinweise.'
  },
  'media-performance': {
    businessImportance: 'Mittel: beeinflusst Nutzbarkeit, Crawl-Kosten und Template-Qualität.',
    scoreInterpretation: 'Niedrige Werte zeigen Performance- oder Medien-Hygiene-Probleme; hohe Werte zeigen stabile Asset- und Template-Signale.',
    managementDescription: 'Fasst Bild-, Ressourcen-, TTFB- und lokale Performance-Signale zusammen.'
  },
  'structured-data': {
    businessImportance: 'Sehr hoch: zentral für maschinenlesbare Entitäten, Seitentypen und GEO-Zitierbarkeit.',
    scoreInterpretation: 'Niedrige Werte zeigen fehlende oder unvollständige Auszeichnung; hohe Werte sprechen für robuste maschinenlesbare Semantik.',
    managementDescription: 'Bewertet, ob relevante Seitentypen und Entitäten mit passenden strukturierten Daten abgebildet sind.'
  },
  'geo-readiness': {
    businessImportance: 'Sehr hoch: direkter Hebel für AI-Search- und GEO-Vorbereitung.',
    scoreInterpretation: 'Niedrige Werte zeigen optionales, aber strategisch relevantes GEO-Potenzial; hohe Werte zeigen gute AI-Search-Vorbereitung.',
    managementDescription: 'Fasst llms.txt, Markdown-/AI-readable-Signale und GEO-spezifische Chancen zusammen.'
  },
  'ai-crawler-policy': {
    businessImportance: 'Mittel: wichtig für Governance, aber nicht automatisch ein Core-SEO-Fehler.',
    scoreInterpretation: 'Niedrige Werte zeigen unklare AI-Crawler-Kommunikation; hohe Werte zeigen eine dokumentierte Policy.',
    managementDescription: 'Bewertet, ob AI-Crawler in robots.txt explizit adressiert werden.'
  },
  'trust-entity': {
    businessImportance: 'Hoch: stärkt Entitätsklarheit, Vertrauen und Validierbarkeit.',
    scoreInterpretation: 'Niedrige Werte zeigen Trust-/Entity-Lücken; hohe Werte sprechen für gut auffindbare Vertrauenssignale.',
    managementDescription: 'Bewertet interne Signale zu Kontakt, Legal, About und Organisations-/Entity-Kontext.'
  },
  'security-server': {
    businessImportance: 'Niedrig bis mittel: Best Practice, aber kein primärer GEO-Score-Treiber.',
    scoreInterpretation: 'Niedrige Werte zeigen Server-Header-Potenzial; hohe Werte sollen den Gesamtreifegrad nur begrenzt anheben.',
    managementDescription: 'Fasst Sicherheitsheader als Best-Practice-Signale mit bewusst niedrigem Gewicht zusammen.'
  },
  'template-rendering': {
    businessImportance: 'Mittel: relevant für JS-abhängige Inhalte und lokale Messbarkeit.',
    scoreInterpretation: 'Niedrige Werte zeigen Rendering- oder Tooling-Auffälligkeiten; hohe Werte zeigen stabile lokale Template-Messung.',
    managementDescription: 'Bewertet Rendering-Sampling, JS-Abhängigkeiten, Konsolenfehler und lokale Tooling-Signale.'
  },
  [UNCATEGORIZED_CATEGORY_ID]: {
    businessImportance: 'Unklar: sichtbarer Fallback für später neu hinzukommende Checks.',
    scoreInterpretation: 'Diese Kategorie sollte nicht still in den Management-Score einfließen, ohne die Zuordnung zu prüfen.',
    managementDescription: 'Sammelt Checks ohne explizite Reifegrad-Zuordnung und macht die Datenlage transparent.'
  }
});

const rawMaturityCategories = [
  {
    id: 'technical-seo',
    name: 'Technische SEO-Basis',
    description: 'Statuscodes, Indexierbarkeit, Canonicals, Robots, Sitemaps und interne Linksignale.',
    recommendation: 'Stabilisiere zuerst Crawl-, Indexierungs- und Canonical-Signale auf den betroffenen URLs.',
    checkIds: [
      'tech.https_reachable',
      'tech.http_to_https_redirect',
      'tech.www_non_www_consistency',
      'tech.status_code_distribution',
      'tech.4xx_pages',
      'tech.5xx_pages',
      'tech.redirect_pages',
      'tech.x_robots_tag_unusual',
      'tech.content_type_html_correct',
      'tech.robots_txt_present',
      'tech.sitemap_present',
      'tech.sitemap_in_robots',
      'tech.sitemap_urls_non_200',
      'tech.internal_search_noindex_policy',
      'tech.noindex_pages',
      'tech.nofollow_pages',
      'tech.canonical_missing',
      'tech.canonical_non_self',
      'tech.canonical_to_other_domain',
      'tech.canonical_target_non_200',
      'tech.internal_links_to_3xx',
      'tech.internal_links_to_4xx_5xx',
      'tech.orphan_like_sitemap_urls',
      'tech.hreflang_x_default_missing',
      'template.noindex_pattern',
      'template.canonical_pattern_issue'
    ]
  },
  {
    id: 'html-head',
    name: 'HTML Head & Snippets',
    description: 'Title, Meta Description, H1, Sprache, Viewport, Open Graph und Browser-Metadaten.',
    recommendation: 'Verbessere zuerst die Snippet- und Head-Signale mit hoher Auswirkung auf viele URLs.',
    checkIds: [
      'tech.title_missing',
      'tech.title_too_short',
      'tech.title_too_long',
      'tech.duplicate_titles',
      'tech.meta_description_missing',
      'tech.meta_description_too_short',
      'tech.meta_description_too_long',
      'tech.duplicate_meta_descriptions',
      'tech.h1_missing',
      'tech.multiple_h1',
      'tech.html_semantics_summary',
      'tech.html_lang_missing',
      'tech.viewport_missing',
      'tech.open_graph_basics_missing',
      'tech.favicon_missing',
      'tech.app_icons_incomplete',
      'tech.webmanifest_missing',
      'tech.charset_utf8_present',
      'template.title_pattern_issue',
      'template.meta_pattern_issue'
    ]
  },
  {
    id: 'structure-quality',
    name: 'Struktur & Seitenqualität',
    description: 'Content-Struktur, Listen, Tabellen, Quellen, Datums- und Autorenhinweise.',
    recommendation: 'Erhöhe die maschinenlesbare Seitenstruktur dort, wo Inhalte wenig gegliedert sind.',
    checkIds: [
      'geo.tables_present',
      'geo.bulletpoints_lists_present',
      'geo.source_or_external_links_present',
      'geo.visible_dates_present',
      'geo.author_hints_present',
      'trust.eeat_signal_summary',
      'trust.ymyl_review_signal',
      'geo.low_structured_sections'
    ]
  },
  {
    id: 'media-performance',
    name: 'Media & Performance',
    description: 'Bildsignale, Medienauszeichnung, TTFB, Ressourcenlast und Lighthouse-Performance.',
    recommendation: 'Optimiere die größten Performance- und Medienprobleme pro Template zuerst.',
    checkIds: [
      'tech.compression_header',
      'tech.cache_control_header',
      'tech.cdn_cache_signals',
      'tech.http_version_support',
      'tech.raw_html_size_large',
      'tech.too_many_js',
      'tech.too_many_css',
      'tech.large_js_total',
      'tech.large_css_total',
      'tech.third_party_scripts_detected',
      'tech.preload_missing',
      'tech.preconnect_missing',
      'tech.resource_hints_summary',
      'tech.imported_resource_performance_signals',
      'tech.high_ttfb',
      'tech.images_without_alt',
      'tech.empty_alt_texts',
      'tech.images_without_width_height',
      'tech.images_without_lazy_loading',
      'tech.large_image_resources',
      'tech.modern_image_format_coverage_low',
      'tech.videoobject_schema_present_missing',
      'template.large_html_pattern',
      'template.low_lighthouse_performance',
      'template.low_lighthouse_seo',
      'template.high_lcp',
      'template.high_tbt'
    ]
  },
  {
    id: 'structured-data',
    name: 'Strukturierte Daten',
    description: 'JSON-LD, Organization, WebSite, Breadcrumb, FAQ, Article, Product und lokale Entitäten.',
    recommendation: 'Ergänze strukturierte Daten nur dort, wo Seitentyp und Inhalt die Auszeichnung tragen.',
    checkIds: [
      'tech.json_ld_parse_errors',
      'tech.schema_types_coverage_summary',
      'tech.organization_missing',
      'tech.website_missing',
      'tech.breadcrumb_missing_low_coverage',
      'tech.faqpage_missing_low_coverage',
      'tech.article_coverage_on_article_like_pages',
      'tech.product_coverage_on_product_like_pages',
      'tech.localbusiness_present_missing',
      'tech.person_present_missing',
      'tech.speakable_missing',
      'tech.organization_sameas_missing',
      'geo.faq_html_present_schema_missing',
      'geo.organization_schema_sameas',
      'geo.breadcrumblist_present',
      'geo.speakable_present',
      'geo.article_blog_pages_article_schema',
      'template.schema_missing_pattern'
    ]
  },
  {
    id: 'geo-readiness',
    name: 'GEO Readiness',
    description: 'AI-Search- und GEO-Signale wie llms.txt, Markdown Twins und strukturierte Antwortfähigkeit.',
    recommendation: 'Behandle diese Signale als optionale GEO-Chancen und priorisiere sie nach Audit-Ziel.',
    checkIds: [
      'geo.llms_txt_present',
      'geo.llms_txt_http_status',
      'geo.llms_full_txt_present',
      'geo.robots_blocks_txt_files',
      'geo.markdown_twin_homepage'
    ]
  },
  {
    id: 'ai-crawler-policy',
    name: 'AI Crawler Policy',
    description: 'Explizite robots.txt-Signale für GPTBot, OAI-SearchBot, ChatGPT-User, Claude, Perplexity, Google-Extended, CCBot, Applebot und Bytespider.',
    recommendation: 'Dokumentiere die gewünschte AI-Crawler-Policy explizit, wenn sie strategisch relevant ist.',
    checkIds: [
      'geo.robots_mentions_gptbot',
      'geo.robots_mentions_oai_searchbot',
      'geo.robots_mentions_chatgpt_user',
      'geo.robots_mentions_claudebot',
      'geo.robots_mentions_claude_web',
      'geo.robots_mentions_perplexitybot',
      'geo.robots_mentions_google_extended',
      'geo.robots_mentions_ccbot',
      'geo.robots_mentions_applebot',
      'geo.robots_mentions_bytespider',
      'geo.ai_bots_policy_summary'
    ]
  },
  {
    id: 'trust-entity',
    name: 'Trust & Entity Signale',
    description: 'Kontakt-, Legal-, About-, Organization- und SameAs-Signale zur Entitätsstärkung.',
    recommendation: 'Schließe zuerst klare Trust- und Kontaktlücken in der internen Verlinkung und Entitätsauszeichnung.',
    checkIds: [
      'geo.impressum_linked',
      'geo.datenschutz_linked',
      'geo.about_linked',
      'geo.contact_linked'
    ]
  },
  {
    id: 'security-server',
    name: 'Security & Server Best Practices',
    description: 'HTTP-Sicherheitsheader und Server-Best-Practices ohne harte SEO-Übergewichtung.',
    recommendation: 'Setze fehlende Sicherheitsheader als Best Practice um, ohne sie als Core-SEO-Fehler zu behandeln.',
    checkIds: [
      'tech.hsts_header',
      'tech.content_security_policy',
      'tech.x_frame_options',
      'tech.x_content_type_options',
      'tech.referrer_policy',
      'tech.permissions_policy',
      'tech.consent_technical_signals'
    ]
  },
  {
    id: 'template-rendering',
    name: 'Template & Rendering',
    description: 'Rendering-Sampling, JS-Abhängigkeit, Konsolenfehler und lokale Tooling-Verfügbarkeit.',
    recommendation: 'Prüfe JS-abhängige Templates und Konsolenfehler dort, wo Rendering-Sampling Auffälligkeiten zeigt.',
    checkIds: [
      'tech.critical_content_raw_html_signal',
      'tech.rendered_word_count_delta',
      'tech.raw_h1_missing_rendered_present',
      'tech.raw_internal_links_fewer_rendered',
      'tech.console_errors_present',
      'tech.js_dependent_content',
      'template.console_errors',
      'template.js_required_content',
      'template.lighthouse_unavailable',
      'template.playwright_unavailable'
    ]
  }
];

export const maturityCategories = rawMaturityCategories.map(withMaturityManagement);

export const uncategorizedMaturityCategory = {
  id: UNCATEGORIZED_CATEGORY_ID,
  name: 'Uncategorized / Unklare Zuordnung',
  description: 'Checks ohne explizite Reifegrad-Zuordnung. Diese werden sichtbar gehalten und nicht still verworfen.',
  recommendation: 'Prüfe die Zuordnung dieser Checks, bevor der Reifegrad als finaler Management-Score genutzt wird.',
  weight: maturityCategoryWeights[UNCATEGORIZED_CATEGORY_ID],
  ...maturityCategoryManagement[UNCATEGORIZED_CATEGORY_ID],
  checkIds: []
};

function withMaturityManagement(category) {
  return {
    ...category,
    weight: maturityCategoryWeights[category.id],
    ...maturityCategoryManagement[category.id]
  };
}

const exactIndex = new Map();
for (const category of maturityCategories) {
  for (const checkId of category.checkIds) {
    exactIndex.set(checkId, category.id);
  }
}

export function getMaturityCategoryForCheck(row = {}) {
  return exactIndex.get(row.checkId) || UNCATEGORIZED_CATEGORY_ID;
}

export function getMaturityCategoryDefinitions({ includeUncategorized = true } = {}) {
  return includeUncategorized ? [...maturityCategories, uncategorizedMaturityCategory] : [...maturityCategories];
}

export function getMappedCheckIds() {
  return new Set(exactIndex.keys());
}
