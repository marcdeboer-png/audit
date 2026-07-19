# Structured-data check validation v1

Stand: 19. Juli 2026. Diese Validierung betrifft die JSON-LD-, Article- und
Product-Familie. Sie aendert weder Audit-Orchestrierung noch globale
Scoringparameter oder historische Runs. Vollstaendige Live-Bodys,
JSON-LD-Inhalte und Run-77-Kopien liegen ausschliesslich unter `/tmp`.

## Fachliche Referenz und Checkaussagen

Die fachliche Gegenpruefung verwendete die am 19. Juli 2026 abgerufenen
offiziellen Primaerquellen: [Google Article structured data](https://developers.google.com/search/docs/appearance/structured-data/article),
[Google Product snippets](https://developers.google.com/search/docs/appearance/structured-data/product-snippet),
[Google structured-data policies](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)
und die Schema.org-Typhierarchie, unter anderem
[Article](https://schema.org/Article), [Product](https://schema.org/Product),
[ProductGroup](https://schema.org/ProductGroup) und
[IndividualProduct](https://schema.org/IndividualProduct).

Wesentliche Abgrenzungen:

- `tech.json_ld_parse_errors` behauptet ausschliesslich einen JSON-Syntaxfehler
  in einem erfolgreich extrahierten `application/ld+json`-Block. Hydration,
  normale Scripts sowie Browser-/Decoder-/Persistenzfehler zaehlen nicht.
- `tech.article_coverage_on_article_like_pages` meldet auf einer erfolgreich
  geladenen, indexierbaren und mit hoher Confidence als einzelner Artikel
  klassifizierten Seite das Fehlen der Article-Familie. `BlogPosting`,
  `NewsArticle`, `TechArticle`, `ScholarlyArticle`, `Report`,
  `SocialMediaPosting` und `LiveBlogPosting` gelten als Untertypen.
- `geo.article_blog_pages_article_schema` nutzt dieselbe Evidence- und
  Coverage-Unit. Die GEO-Perspektive bleibt sichtbar, aber scorefrei und
  reviewpflichtig; sie erzeugt keinen zweiten Abzug.
- `tech.product_coverage_on_product_like_pages` prueft nur, ob eine mit hoher
  Confidence erkannte Produktdetailseite einen Product-Familientyp besitzt.
  `ProductGroup`, `IndividualProduct` und `ProductModel` belegen die Familie,
  nicht automatisch Rich-Result-Eignung oder vollstaendige Offer-Daten.

Google dokumentiert fuer Article derzeit keine zwingende Eigenschaft. Bei
Product-Snippets sind `name` und mindestens eine der Alternativen
`review`, `aggregateRating` oder `offers` fuer die Google-Ergebnisfunktion
relevant. Diese externen Eligibility-Regeln werden bewusst nicht mit den
vorhandenen reinen Presence-Checks vermischt. Empfohlene Eigenschaften sind
keine Syntaxfehler und keine automatisch scorewirksamen Missing-Findings.

## Inventar

| Check | Severity | Evidence | Score | Aussage / Entscheidung |
| --- | --- | --- | --- | --- |
| `tech.json_ld_parse_errors` | High (isolierter Block dynamisch Medium) | primary_required | score-capable | Fixture-validiert; realer positiver Syntaxfehler fehlt |
| `tech.article_coverage_on_article_like_pages` | Low | primary_conditional | score-capable | `validated_with_limits`, nur High-Confidence-Detailseiten |
| `geo.article_blog_pages_article_schema` | Medium | primary_conditional | scorefrei | dauerhaft manuelle GEO-Einordnung, gemeinsame Article-Unit |
| `tech.product_coverage_on_product_like_pages` | Medium | primary_conditional | score-capable | `validated_with_limits`, Product-Familienpraesenz |
| `tech.schema_types_coverage_summary` | Low | inventory | scorefrei | `validated_with_limits`, Typinventar ohne Qualitaetsurteil |
| `tech.breadcrumb_missing_low_coverage` / `geo.breadcrumblist_present` | Low | primary_conditional | konditional | manuelle Eignungspruefung bleibt erforderlich |
| `tech.organization_missing`, `tech.website_missing`, `tech.person_present_missing` | Low | opportunity | konditional | nicht globale Pflicht; manuelle Einordnung |
| `tech.organization_sameas_missing` / `geo.organization_schema_sameas` | Low | conditional | konditional | Property-Fakt jetzt kompakt messbar; offizielle Profile bleiben Kontext |
| `tech.faqpage_missing_low_coverage` / `geo.faq_html_present_schema_missing` | Low/Medium | conditional | konditional | sichtbare FAQ-Eignung und Policy-Kontext bleiben manuell |
| `tech.localbusiness_present_missing`, `tech.videoobject_schema_present_missing` | Medium/Low | conditional | konditional | Seitentyp-/Medienkontext bleibt manuell |
| `tech.speakable_missing` / `geo.speakable_present` | Low | opportunity | konditional | optionale Gelegenheit, keine Pflicht |
| `template.schema_missing_pattern` | Low | primary_conditional | scorefrei | Exakte Typhierarchie und getrennte Ursachen; Template-Homogenitaet und Intent bleiben reviewpflichtig |

## Unabhaengige Validierung

39 serielle GET-Probes auf 15 oeffentlichen Domains deckten kleine statische
Sites, lokale redaktionelle Sites, Dokumentation, Redaktion, E-Commerce und
CSR ab: `marcdeboer.de`, `trinkgut-zierles.de`, `react.dev`, `web.dev`,
`developer.mozilla.org`, `www.ikea.com`, `app.uniswap.org`, `nextjs.org`,
`theguardian.com`, `lego.com`, `apple.com`, `store.google.com`,
`microsoft.com`, `samsung.com` und `nike.com`. Neun gezielte Browserprobes
verglichen Raw- und stabilisierten DOM-Zustand. Blocker/WAF-Antworten wurden
nicht umgangen und nicht als Schemafehler bewertet.

Die Gegenpruefung verwendete einen separaten Python-HTMLParser, Pythons
JSON-Parser, eigene Entity-/`@graph`-Traversal, sichtbare H1-/Article-/Preis-
und Commerce-Signale sowie Playwright nur fuer Raw-/Rendered-Abweichungen.
Sie verwendete nicht den Audit-Extraktor. Gemessen wurden ausschliesslich
kompakte Typ-, Property-, Status-, Hash- und Seitentypprovenienz.

Reale Gegenbelege:

- Ein echter React-Blogartikel besitzt sichtbaren redaktionellen Inhalt, aber
  kein Article-JSON-LD: realer positiver Missing-Fall.
- Article-Untertypen wurden auf Trinkgut (`BlogPosting`), Next.js
  (`TechArticle`), Guardian (`NewsArticle`) sowie Article auf marcdeboer.de und
  web.dev bestaetigt.
- Die LEGO-Themenseite enthaelt Product-Karten, ist aber eine Kategorie. Sie
  reproduzierte die Gefahr, Product-Praesenz allein als Produktdetailseite zu
  interpretieren.
- Eine Google-Store-Produktdetailseite zeigte Produktname, Preis und
  Commerce-Kontext, aber nur Organization-JSON-LD: realer positiver
  Product-Missing-Fall.
- Product-Negativfaelle mit passendem Schema wurden auf Trinkgut, IKEA,
  Apple, Microsoft, Samsung und Nike bestaetigt; Nike deckte ProductGroup ab.
- Kein organischer JSON-LD-Syntaxfehler wurde gefunden. 39 reale Negativfaelle
  und umfassende Positiv-Fixtures rechtfertigen daher keine Hochstufung des
  High-Checks ueber `fixture_validated` hinaus.

## Korrekturen

Die Extraktion speichert pro Block und Entity Quelle (`raw`/`rendered`),
Block-/Entityindex, Script-Type, Byte-Laenge, SHA-256, Parserfehlertyp und
-position, Entity-Pfad/`@id`, Referenzen sowie Property-Namen. Vollstaendige
fremde JSON-LD-Bodys werden bei neuen Runs nicht persistiert. Alte Runs mit
`rawJson` bleiben lesbar und werden nicht veraendert.

Explizite Extraktionszustaende unterscheiden gefundene und geparste Bloecke,
Syntaxfehler sowie extrahierte und ueber `@id` verknuepfte Entitaeten.
`entityCompletenessStatus=not_evaluated` verhindert, dass eine reine
Typerkennung als Property-Vollstaendigkeitspruefung erscheint. Leere
`application/ld+json`-Tags bleiben sichtbar, sind aber weder Syntax-Finding
noch positiver Parse-Beleg.

Eine zentrale, case-sensitive Typhierarchie ersetzt Stringteiltreffer.
`@graph`, Arrays, verschachtelte Entitaeten, mehrere `@type`-Werte und
`@id`-Verknuepfungen werden verarbeitet. Raw und stabilisiertes Render-Schema
bleiben getrennt; ein instabiler oder technisch fehlgeschlagener Browserlauf
erzeugt keinen Website-Syntaxfehler.

Die Seitentypklassifikation speichert Confidence und Signale. Archive,
Kategorien, Tag-/Autorenlisten, Produktkategorien und Such-/Filterpfade werden
vor Schema-Missing-Checks ausgeschlossen. Ein Product- oder Article-Slug oder
ein einzelner Schematyp genuegt nicht fuer einen High-Confidence-Missing-Fail.
Unklare Kandidaten und Kandidaten ohne bekannte Indexierbarkeit bleiben
`insufficient_evidence`.

Der scorefreie Template-Roll-up verwendet dieselbe exakte Typhierarchie,
trennt Article-, Product-, LocalBusiness- und Breadcrumb-Ursachen und verlangt
mindestens drei hoch-konfidente, erfolgreiche, indexierbare HTML-Seiten sowie
mindestens 50 Prozent Betroffenheit im homogenen Scope. Ein Typname wie
`NotArticle` gilt nicht aufgrund eines Stringteiltreffers als Article.

## Run 77

Run 77 wurde nur in einer temporaren Kopie rekonstruiert. Das Original bleibt
unveraendert.

| Check | Original | Rekonstruktion | Bewertung |
| --- | --- | --- | --- |
| `tech.json_ld_parse_errors` | OK, 0 | OK, 0 | bestaetigt: 3.717 eindeutige gespeicherte JSON-Bodys separat erfolgreich geparst; historische Blockprovenienz bleibt begrenzt |
| `tech.article_coverage_on_article_like_pages` | Warning, 7 | OK, 0 | sieben False Positives: drei Archive sowie vier Artikel mit `BlogPosting` |
| `geo.article_blog_pages_article_schema` | Warning, 7 | OK, 0 | gleicher Root Cause; zusaetzlicher Doppelabzug ist unzulaessig |
| `tech.product_coverage_on_product_like_pages` | Warning, 2 | OK, 0 | falscher Scope: beide gespeicherten URLs waren 404, nicht indexierbar und ohne belastbare Produktdetail-Evidenz |

Der aktuelle Live-Zustand bestaetigt `BlogPosting` auf dem geprueften
Trinkgut-Artikel und Product/Offer auf einer erreichbaren Produktdetailseite.
Die zwei damaligen numerischen Produktpfade liefern heute 404. Daraus wird
keine rueckwirkende historische Inhaltsaussage abgeleitet.

## Tests und Grenzen

`tests/structured-data-validation.test.js` deckt Objekt, Array, `@graph`,
mehrere Bloecke, verschachtelte Entitaeten, Referenzen, Mehrfachtypen,
Syntaxfehler, leere/falsche Script-Typen, Hydration, Render-only-Schema,
Article-/Product-Untertypen, Archive/Kategorien, Confidence, technische
Fehler, Deduplizierung, Run-Isolation und datensparsame Persistenz ab.

Bekannte Grenzen: Microdata/RDFa bleiben getrennte Inventarquellen;
semantische Konsistenz mit dem sichtbaren Inhalt und Google-Eligibility sind
nicht vollautomatisch bewiesen; unbekannte Templates koennen bewusst in
`insufficient_evidence` fallen. Ein Registry-Status bedeutet belastbare
Evidenz innerhalb dieser Grenzen, nicht universelle Schema-Richtigkeit.
