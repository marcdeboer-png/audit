# HTML head and heading check validation v1

Stand: 20. Juli 2026. Diese Validierung betrifft ausschliesslich bestehende
HTML-Head-, Title-, Meta-Description-, Sprach- und Heading-Checks. Auditablauf,
globale Scoringparameter und historische Runs wurden nicht veraendert.

## Inventar und fachliche Aussage

| Check | Severity | Score | Registry vor/nach | Automatisierte Aussage |
| --- | --- | --- | --- | --- |
| `tech.title_missing` | Medium | ja | single-domain / cross-domain | Eine geeignete indexierbare HTML-Seite besitzt im vollstaendigen effektiven Dokumentzustand keinen verwertbaren direkten Head-Title. |
| `tech.title_too_short` | Low | nein | review / review | Der effektive Title liegt unter dem internen Diagnosewert von 20 Zeichen. |
| `tech.title_too_long` | Low | nein | review / review | Der effektive Title liegt ueber dem internen Diagnosewert von 65 Zeichen. |
| `tech.duplicate_titles` | Medium | ja | single-domain / review | Mindestens zwei geeignete, nicht kanonisch konsolidierte URLs teilen denselben normalisierten effektiven Title. |
| `tech.meta_description_missing` | Low | nein | fixture / review | Eine geeignete HTML-Seite besitzt keine verwertbare effektive Meta Description; dies ist eine redaktionelle Opportunity, keine Indexierungsblockade. |
| `tech.meta_description_too_short` | Low | nein | review / review | Die effektive Description liegt unter dem internen Diagnosewert von 70 Zeichen. |
| `tech.meta_description_too_long` | Low | nein | review / review | Die effektive Description liegt ueber dem internen Diagnosewert von 160 Zeichen. |
| `tech.duplicate_meta_descriptions` | Low | nein | single-domain / review | Geeignete, nicht kanonisch konsolidierte URLs teilen dieselbe normalisierte effektive Description. |
| `tech.h1_missing` | Low | nein | single-domain / review | Eine geeignete HTML-Seite besitzt keine sichtbare oder zugaenglich benannte H1. Ob dies fachlich ein Defekt ist, erfordert Seitentypkontext. |
| `tech.multiple_h1` | Low | nein | review / review | Mehr als eine sichtbare oder zugaenglich benannte H1 ist vorhanden; dies ist ein Review-Signal. |
| `tech.html_semantics_summary` | Low | nein | review / review | Inventar sichtbarer/namentlich bestimmbarer Headings und semantischer Elemente. |
| `tech.html_lang_missing` | Medium | ja | single-domain / cross-domain | Eine geeignete HTML-Seite besitzt im effektiven Zustand kein nicht-leeres `html[lang]`. Inhaltliche Sprachrichtigkeit ist nicht Teil der Aussage. |
| `tech.raw_h1_missing_rendered_present` | Low | nein | limits / limits | Raw HTML besitzt keine verwendbare H1, der erfolgreich stabilisierte Browserzustand dagegen schon. |
| `template.title_pattern_issue` | Low | nein | review / review | Mindestens drei URLs eines homogenen Templates teilen mit mindestens 80 % Evidence-Coverage denselben effektiven Title-Problemtyp. |
| `template.meta_pattern_issue` | Low | nein | review / review | Mindestens drei URLs eines homogenen Templates teilen mit mindestens 80 % Evidence-Coverage denselben effektiven Description-Problemtyp. |

Die vier Severity-Aenderungen sind fachliche Korrekturen an zuvor zu starken
Aussagen: fehlende Description, fehlende H1, mehrere H1 und eine reine
Raw-/Rendered-H1-Differenz sind nun Low und scorefrei. Die Title- und
Description-Laengen bleiben interne Diagnosewerte. Google nennt fuer Title
und Meta Description keine feste Zeichenobergrenze; Titel werden aus mehreren
Quellen erzeugt und Snippets geraeteabhaengig gekuerzt. Daher bleiben
Laengenchecks scorefrei und reviewpflichtig.

Quellen: [Google Title Links](https://developers.google.com/search/docs/appearance/title-link),
[Google Snippets](https://developers.google.com/search/docs/appearance/snippet),
[WCAG 2.4.2 Page Titled](https://www.w3.org/WAI/WCAG22/Understanding/page-titled.html),
[WCAG 2.4.6 Headings and Labels](https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels),
[WCAG 2.2 Language of Page](https://www.w3.org/TR/WCAG22/),
[WHATWG title](https://html.spec.whatwg.org/multipage/semantics.html#the-title-element)
und [WHATWG headings](https://html.spec.whatwg.org/dev/sections.html#headings-and-outlines).

## Unabhaengige Realvalidierung

Serielle GET-Probes wurden am 19./20. Juli 2026 auf 31 URLs von 15
oeffentlichen Domains ausgefuehrt. Vollstaendige Bodies wurden nur temporaer
verarbeitet; dauerhaft dokumentiert sind Status, Content-Type, Bytezahl,
SHA-256, direkte Headwerte, sichtbare/namentlich bestimmbare H1, Sprache,
Indexierbarkeit und Redirectkette.

| Archetyp | Domains |
| --- | --- |
| kleine statische Experten-/Unternehmensseite | `marcdeboer.de`, `trinkgut-zierles.de` |
| hydrierte Dokumentation | `react.dev`, `web.dev`, `developer.mozilla.org`, `nextjs.org` |
| grosse E-Commerce-/SaaS-Seite | `www.ikea.com`, `shopify.com`, `stripe.com`, `apple.com` |
| CSR-App | `app.uniswap.org`, `app.aave.com` |
| Redaktion/Enzyklopaedie | `theguardian.com`, `wikipedia.org` |
| oeffentliche Institution | `gov.uk` |

Zusaetzliche reale Grenzfaelle fuer fehlenden Title, fehlendes `lang`, mehrere
H1 und fehlende H1 wurden auf `info.cern.ch`, `neverssl.com`, `gnu.org`,
`motherfuckingwebsite.com`, `httpbin.org`, `w3.org`, `example.edu`,
`textfiles.com` und `spacejam.com` geprueft. CERN, HTTPBin und Textfiles
lieferten wiederholbar erfolgreiche HTML-Dokumente ohne Title; die breit
gestreuten Negativfaelle behielten ihren Title. Diese Seiten dienen nur als
oeffentliche Implementierungsbeispiele, nicht als Empfehlung fuer deren
Inhalt.

Die Browser-Gegenpruefung erfolgte gezielt, wenn Raw-HTML die fachliche
Aussage nicht tragen konnte:

- `web.dev` besitzt im Raw-Zustand keinen Title, nach Lokalisierungs-Hydration
  aber einen effektiven Title. Es entsteht kein `title_missing`.
- `trinkgut-zierles.de/sortiment` besitzt Raw keine H1, im stabilisierten DOM
  jedoch `Unser Sortiment`. Das ist eine Raw-/Rendered-Diagnose, kein
  effektives H1-Fehlen.
- `app.uniswap.org` und `app.aave.com` bestaetigen, dass App-Shell-/Hydration-
  Seiten ohne stabilen Browserzustand weder Pass noch Missing liefern duerfen.
- `app.aave.com` lieferte auf zwei unterschiedlichen App-Routen denselben
  effektiven Title und dieselbe Description. Die Gruppe ist objektiv; ihre
  fachliche Prioritaet bleibt reviewpflichtig.
- Eine Browsernavigation zur Guardian-Seite schlug technisch fehl. Daraus
  wurde kein Website-Finding abgeleitet.

## Dokumentzustand und Scope

`raw`, `initial_rendered`, `settled_rendered` und `effective` bleiben getrennt.
Raw ist effektiv, wenn es vollstaendig ist und kein Renderbedarf besteht.
Wenn benoetigte Raw-Fakten fehlen, entscheidet nur ein erfolgreicher stabiler
Renderzustand. Instabiles oder fehlgeschlagenes Rendering fuehrt zu
`insufficient_evidence` beziehungsweise `technical_error`, niemals zu einem
Missing-Pass oder Missing-Fail.

Die Head-Familie verwendet nun einen gemeinsamen Population- und
Normalisierungspfad. Bewertbar sind nur erfolgreiche finale 2xx-HTML-Seiten
mit erfolgreicher Extraktion und explizit bekannter Indexierbarkeit. Redirects,
4xx/5xx, 204, Nicht-HTML, Rechtsseiten, technische Fehler und nicht
klassifizierte historische Indexierbarkeit bleiben ausserhalb eines normalen
Missing- oder Duplicate-Findings. Canonicalisierte URLs werden nicht in
Duplicate-Gruppen aufgenommen; ein Missing-Fakt kann fuer eine erfolgreich
geladene indexierbare Seite dagegen weiterhin relevant sein.
Canonical-Konflikte bleiben fuer die Gruppierung Evidence-Luecken.

## Head- und Heading-Extraktion

Der Extraktor speichert alle direkten `head > title`- und
`meta[name=description]`-Werte. Fehlend, leer, Whitespace, mehrfach identisch
und mehrfach widerspruechlich bleiben unterscheidbar. `title` im Body ist kein
Head-Title; Open-Graph-Description ersetzt keine klassische Description.

H1-Fakten unterscheiden Elementvorhandensein, statische Sichtbarkeit und den
verwendbaren Namen. Die Namensreihenfolge ist sichtbarer Text, `aria-label`,
`aria-labelledby`, Bild-`alt` und zugaenglicher SVG-Name. `hidden`,
`aria-hidden=true`, Inline-`display:none` und `visibility:hidden` werden auch
ueber Vorfahren ausgeschlossen; der Browserzustand prueft zusaetzlich
berechnete Styles. Geschlossene Shadow Roots, Interaktionszustaende und
Stylesheetfehler ausserhalb eines erfolgreichen Renderlaufs bleiben bekannte
Grenzen.

Mehrere H1 sind kein automatischer schwerer SEO-Fehler. HTML erlaubt in
geeigneten Strukturen mehrere Top-Level-Headings; eine starre Regel wie
„H2 darf nie vor H1 kommen“ wird nicht als Indexierungsblockade behandelt.

## Duplicate- und Template-Semantik

Duplicate-Gruppen verwenden den effektiven Wert und eine konservative
Normalisierung: Unicode NFKC, HTML-Parser-Dekodierung, zusammengefasster
Whitespace und Case-Folding. Markennamen, Trennzeichen, Seitennummern und
lokalisierte Varianten werden nicht aggressiv entfernt. Vollstaendige
Gruppenzahl und betroffene URL-Zahl entstehen vor dem zehnteiligen Sample.
Detailansicht, Finding, JSON und CSV greifen auf denselben Gruppierer zu.

Template-Patterns verwenden ebenfalls den effektiven vollstaendigen Zustand.
Ein Pattern benoetigt mindestens drei auswertbare URLs, mindestens drei
Betroffene, mindestens 50 % Anteil, mindestens 80 % Evidence-Coverage und
einen homogenen Problemtyp. URL-Mitglieder und Roll-up teilen einen
Root-Cause-Kontext; das Pattern bleibt scorefrei.

## Run 77

Der Originalrun blieb unveraendert. Die read-only Forensik ergab:

- `title_missing`: 18 damalige Raw-Treffer, davon zwei 404-Scopefehler; fuer
  die verbleibenden 16 fehlt eine vollstaendige historische Renderrekonstruktion.
- `h1_missing`: drei fachlich relevante 200-Seiten und zwei fälschlich
  einbezogene 404-Seiten.
- `html_lang_missing` und `raw_h1_missing_rendered_present`: die sichtbaren
  Stichproben waren Fehlerseiten und damit `incorrect_scope`.
- `duplicate_titles`: historisch 217 betroffene URLs in 57 Gruppen, im Report
  wegen eines frueheren Sample-Limits nur 119 sichtbar.
- `duplicate_meta_descriptions`: historisch 219 URLs in 53 Gruppen, sichtbar
  waren nur 126.
- Description-Missing war anhand der gespeicherten erfolgreichen HTML-Fakten
  messbar; seine damalige Medium-Scorewirkung war jedoch zu stark.
- Laengenbefunde waren messbar, aber als objektive Fehler falsch priorisiert.

Der heutige Live-Zustand wird davon getrennt behandelt. Aenderungen an der
Website beweisen weder Richtigkeit noch Fehler des damaligen Runs.

## Registry-Entscheidung und Grenzen

`tech.title_missing` und `tech.html_lang_missing` sind
`cross_domain_validated`: mehrere reale positive und negative
Implementierungen, direkte Fixtures, drei Wiederholungen und null offene
FP/FN liegen vor. Der Sprachcheck behauptet ausdruecklich nicht, die
inhaltlich richtige Sprache automatisch zu erkennen.

`tech.raw_h1_missing_rendered_present` bleibt `validated_with_limits` und
scorefrei. Description-, H1-, Multiple-, Duplicate-, Laengen- und Templateaussagen sind
`manual_review_required`; ihre Fakten sind automatisierbar, die fachliche
Schlussfolgerung jedoch kontextabhaengig.

Temporaere Wahrheitsmatrix, kompakte Provenienz, Run-77-Vergleich und
Artefaktmanifest liegen ausschliesslich unter
`/tmp/html-head-heading-validation-v1/` und werden nicht committed.
