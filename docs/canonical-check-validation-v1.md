# Canonical check validation v1

Stand: 19. Juli 2026. Validierte Logikversion:
`canonical-validation-v1`. Diese Validierung aendert weder den Auditablauf
noch globale Scoringparameter oder Default-Severities.

## Aussagen und Vertrauensentscheidung

| Check | Exakte automatisierte Aussage | Severity | Score / Nutzung | Registry |
| --- | --- | --- | --- | --- |
| `tech.canonical_missing` | Eine erfolgreich geladene, indexierbare, nicht rechtliche HTML-Seite besitzt im vollstaendigen effektiven Dokumentzustand keinen Canonical. | Medium | scorewirksam; Availability-Gate erforderlich | `cross_domain_validated` |
| `tech.canonical_non_self` | Mindestens ein effektiver Canonical unterscheidet sich nach Normalisierung von der final ausgelieferten URL oder mehrere Canonical-Tags widersprechen sich. | Low | scorefrei; Intent-Review | `manual_review_required` |
| `tech.canonical_to_other_domain` | Ein effektiver Canonical liegt auf einer anderen registrierbaren Domain. | Medium | scorefrei; Publishing-/Migrationsreview | `manual_review_required` |
| `tech.canonical_target_non_200` | Ein im Lauf per GET bekannter Canonical-Zielrequest leitet initial um, endet non-200 oder liefert final kein HTML. | Medium | scorewirksam; unbekannte notwendige Messung ist kein Pass | `fixture_validated` |
| `template.canonical_pattern_issue` | Mindestens drei URLs desselben belastbaren Template-/Seitentyps oder eines siteweiten Scopes zeigen dieselbe Canonical-Ursache bei mindestens 50 % Anteil und 80 % Evidenzabdeckung. | High | abgeleiteter scorefreier Roll-up; manueller Scope-/Intent-Review | `manual_review_required` |

`self` bezieht sich auf die finale ausgelieferte URL, nicht blind auf die
angefragte Alias-URL. Die Vergleichsnormalisierung entfernt Fragmente,
Standardports, Trackingparameter und einen rein mechanischen trailing slash,
sortiert Queryparameter und normalisiert unreserved Percent-Encoding. Sie
setzt HTTP und HTTPS, www und Apex, verschiedene Querysets, `index.html` und
unterschiedliche Pfade nicht pauschal gleich. Solche Abweichungen bleiben als
Fakt sichtbar und benoetigen bei `non_self` eine Intent-Pruefung.

## Unabhaengige Realvalidierung

Die manuelle Wahrheit stammt nicht aus den Checkausgaben. Verwendet wurden
serielle `curl`-GETs mit vollstaendigen Redirectketten, ein unabhaengiger
HTML-Parser, eine eigene URL-Normalisierung, getrennte GETs der Canonical-Ziele
und Playwright nur fuer Raw-/Rendered-Gegenpruefungen. Bodies, Header und
Browsermessungen liegen ausschliesslich temporaer unter
`/tmp/canonical-validation-v1/`.

Geprueft wurden 45 URLs auf neun Implementierungen plus ein oeffentlicher
Syndication-Fall auf DEV:

- `marcdeboer.de`: kleine statische Expertenwebsite;
- `trinkgut-zierles.de`: lokale dynamische Commerce-Website und Run-77-Domain;
- `react.dev`, `web.dev`, `developer.mozilla.org`: SSR-/hydratisierte
  Dokumentations- und Redaktionsseiten;
- `www.ikea.com`: grosse E-Commerce-Implementierung;
- `app.uniswap.org`, `app.aave.com`: CSR-/App-Shell-Implementierungen;
- `nextjs.org`: hybride SSR-/Hydration-Dokumentation;
- `dev.to`: absichtlich fremddomainig canonicalisierte Syndication-Seite.

Die 45 Hauptprobes ergaben im effektiven Zustand 37 Self-Canonicals, sieben
fehlende Canonicals und einen absichtlichen Query-Konsolidierungsfall. Uniswap
lieferte auf allen fuenf Probes keinen Raw-Canonical, setzte ihn aber nach
stabilem Rendering korrekt. Aave lieferte auf fuenf aktuellen Browserprobes
auch gerendert keinen Canonical; ein isolierter Browser-all-Lauf bestaetigte
das auf sechs Seiten. Next.js hatte auf Startseite und Showcase weder raw noch
gerendert einen Canonical. Die uebrigen negativen Faelle stimmten zwischen
Parser, Browser und Checklogik ueberein.

Der DEV-Fall canonicalisierte absichtlich auf die urspruengliche externe
Publikation; Quelle und Ziel lieferten 200. Das belegt, dass die
Fremddomain-Beziehung automatisierbar ist, die Fehlerbewertung aber nicht.
Fuer `canonical_target_non_200` gab es 39 reale negative Zielbeobachtungen,
aber keinen natuerlich auftretenden realen Positivfall. Deshalb bleibt dieser
Check trotz positiver 308-, 404-, 410-, 500- und Non-HTML-Fixtures konservativ
`fixture_validated`.

## Belegte Korrekturen

- Non-Self verglich zuvor den Canonical mit der angefragten normalisierten URL.
  Dadurch wurden Redirect-Aliase aus Run 77 mit echten Konsolidierungen
  vermischt. Nun gelten nur direkte erfolgreiche indexierbare HTML-Antworten,
  und der Vergleich nutzt die finale URL.
- Die Fremddomainabfrage verwendete URL-Prefix-`LIKE`. Dadurch konnte
  `example.com.evil.invalid` als eigene Domain durchrutschen, waehrend
  Subdomains derselben registrierbaren Domain nicht sauber klassifiziert
  wurden. Die neue Auswertung nutzt ICANN-Public-Suffix-Daten.
- Die Zielpruefung betrachtete nur den finalen Status eines gespeicherten
  Ziels. Initiale 301/302/307/308 wurden verdeckt; unbekannte Ziele konnten wie
  ein Pass erscheinen. Initialstatus, Redirectkette, Finalstatus, Final-URL und
  Content-Type sind nun getrennte Evidenz. Eine fehlende notwendige Messung
  fuehrt zu `insufficient_evidence`.
- Der Extraktor behielt nur den ersten Canonical. Raw und gerendert bleiben nun
  alle Canonical-Tags erhalten; identische Duplikate und widerspruechliche
  Werte werden unterschieden.
- Der Pattern-Check nutzte Raw-Strings, konnte Ursachen zusammenwerfen und
  erkannte kein siteweites Muster ueber mehrere kleine Templates. Er arbeitet
  jetzt auf effektiver Canonical-Semantik, trennt Ursachen, prueft Run-Scope,
  Seitentyp, Stichprobe, Quote und Evidence Coverage und zaehlt Samples erst
  nach der vollstaendigen Aggregation.

Die neue Darstellung in Detailansicht und CSV zeigt erwarteten Self-Canonical,
alle Canonical-Werte sowie initialen und finalen Zielstatus. Non-Self,
Fremddomain und Pattern bleiben wegen legitimer Konsolidierungsfaelle
reviewpflichtig und scorefrei. Die bestehenden Default-Severities wurden nicht
veraendert.

## Run 77

Run 77 wurde nur ueber eine temporaere Datenbankkopie rekonstruiert. Der alte
`canonical_missing`-Pass und der Fremddomain-Pass blieben bestaetigt. Der alte
Non-Self-Befund sank von 96 auf 88 URL-Fakten: sechs Redirect-Aliase und zwei
Nicht-2xx-Seiten fallen aus dem direkten, indexierbaren HTML-Scope; die verbleibenden
Faelle sind ueberwiegend absichtliche Filter-/Unterkategorie-Konsolidierungen
und daher keine automatisch scorewirksamen Fehler.

Der alte `canonical_target_non_200`-Pass bleibt nur fuer die gespeicherten
finalen Zielstatus nachvollziehbar. Da der historische Lauf keine initialen
Zielstatuscodes und Redirectketten speicherte, rekonstruiert die neue Logik
diesen Check als `insufficient_evidence`, nicht als Pass. Die heutige
Initial-Redirect-Aussage ist historisch nicht vollstaendig rekonstruierbar. Der
Pattern-Check war im Originallauf nicht vorhanden; die temporaere neue
Rekonstruktion erkennt ein homogenes Non-Self-Muster mit 88 von 118 URLs, das
wegen des Filter-Intents manuell einzuordnen ist. Originalrun und produktive
Datenbank wurden nicht veraendert.

## Fixtures und bekannte Grenzen

`tests/canonical-validation.test.js` deckt relative und absolute Canonicals,
Normalisierung, Raw-/Rendered-Provenienz, identische und widerspruechliche
Tags, Redirect-/Fehler-/Nicht-HTML-Scope, Subdomains und Fremddomains,
Initial-Redirects, 404/410/500, fehlende Zielmessungen, Run-Isolation,
Pattern-Schwellen, gemischte Ursachen und Sample-Limits ab.

Bekannte Grenzen bleiben:

- technische Browser-, Netzwerk- oder WAF-Fehler koennen nur als fehlende
  Evidenz, nicht als Canonical-Defekt bewertet werden;
- Content-Gleichwertigkeit, Syndication, Migration, Filter- und
  Internationalisierungsstrategie benoetigen menschlichen Kontext;
- alte Runs ohne initiale Status- und Multi-Canonical-Provenienz behalten ihre
  historischen Daten und werden nicht rueckwirkend umgedeutet;
- `final` beziehungsweise ein Check-Pass bedeutet ausreichende Evidenz im
  geplanten Scope, nicht vollstaendige Website- oder Indexwahrheit.
