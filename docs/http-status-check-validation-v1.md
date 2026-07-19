# HTTP status and host-consistency check validation v1

Stand: 19. Juli 2026. Validierte Logikversion:
`http-status-validation-v1`. Der Batch aendert weder den Auditablauf noch
globale Scoringparameter. Er verwendet GET als fachliche Statusreferenz und
speichert hoechstens fuenf kompakte Messversuche ohne Response-Body.

## Aussagen und Vertrauensentscheidung

| Check | Exakte Aussage | Severity / Nutzung | Registry |
| --- | --- | --- | --- |
| `tech.https_reachable` | Mindestens ein gemessener HTTPS-Kandidat lieferte eine HTTP-Antwort und endete weiterhin auf HTTPS. | High; Transportaussage, nicht Seiten-Health | `validated_with_limits` |
| `tech.http_to_https_redirect` | Relevante HTTP-Kandidaten leiten per 301/308 auf HTTPS; temporaere Redirects und Verlust von Pfad/Query bleiben sichtbar. | Medium; scorewirksam mit Kontextlimit | `validated_with_limits` |
| `tech.www_non_www_consistency` | Apex und www konvergieren, soweit beide fachlich relevante Hostvarianten sind, permanent auf denselben Host. | Medium; automatisiert mit Review bei Konflikt | `validated_with_limits` |
| `tech.4xx_pages` | Eine im Run-Scope per GET gemessene URL endet stabil mit 4xx; 408/429 sind keine deterministischen 4xx-Seitenfehler. | Medium; 401/403 mit Kontextreview | `cross_domain_validated` |
| `tech.5xx_pages` | Eine URL endet in mindestens zwei konsistenten Versuchen mit 500/502/503/504 beziehungsweise einem bestaetigten 5xx. | High; bestaetigtes Finding mit Review | `fixture_validated` |
| `tech.redirect_pages` | Eine angefragte URL lieferte initial 3xx. | scorefreies Inventar | `cross_domain_validated` |
| `tech.internal_links_to_3xx` | Ein interner HTML-Seitenlink zeigt auf eine URL mit initialem 3xx. | Medium | `single_domain_validated` |
| `tech.internal_links_to_4xx_5xx` | Ein interner HTML-Seitenlink endet stabil mit 4xx/5xx; Vorkommen und eindeutige Ziele werden getrennt gezaehlt. | Medium bei Einzelfaellen, High bei breitem Scope | `single_domain_validated` |
| `tech.sitemap_urls_non_200` | Eine gemessene interne Sitemap-URL liefert nicht direkt initial und final 200; ein Voll-Pass verlangt vollstaendige versionierte Discovery- und Statusabdeckung. | Medium; reale Positivvalidierung offen | `fixture_validated` |
| `tech.status_code_distribution` | Inventar der initialen und finalen GET-Statuscodes; technische Fehler sind separat. | scorefreies Inventar | `single_domain_validated` |
| `tech.synthetic_not_found_handling` | Vier kollisionssichere unbekannte URLs liefern stabil 404/410; Soft-404, Homepage-Redirect, Loop und bestaetigte 5xx werden getrennt. | High; technische Fehler scorefrei | `cross_domain_validated` |

Ein HTTPS-Response mit 404 oder 500 beweist, dass TLS/HTTPS und der HTTP-Server
erreichbar waren; er beweist nicht, dass die Seite gesund ist. Diese Aussage
bleibt den Statuschecks vorbehalten. Ein initialer Redirect auf final 200 ist
kein Fehlerlink, aber ein Befund der getrennten 3xx-Familie.

## Unabhaengige Realvalidierung

Die Wahrheit wurde nicht aus Checkausgaben uebernommen. Verwendet wurden
serielle `curl`-GETs ohne Body-Persistenz, Redirectketten mit und ohne `-L`,
separate HEAD-Gegenproben, ein unabhaengiger URL-/Hostvergleich und bis zu drei
niedrigfrequente Wiederholungen fuer instabile Statuscodes. Geprueft wurden:

- `marcdeboer.de`: kleine statische Expertenwebsite, www nach Apex;
- `trinkgut-zierles.de`: dynamische lokale Commerce-Site, Apex nach www;
- `react.dev`, `web.dev`, `developer.mozilla.org`, `nextjs.org`:
  SSR-/Hydration-/Dokumentationsarchitekturen;
- `www.ikea.com`: grosse E-Commerce-Architektur, Apex nach www;
- `app.uniswap.org`: echte CSR-Subdomain ohne erfundene
  `www.app.uniswap.org`-Pflicht.

72 abschliessende Root-, Deep-Path-, Query- und GET/HEAD-Messungen waren
technisch erfolgreich. Beobachtet wurden initial 200, 301, 302, 307, 308 und
404; die finalen Antworten waren 200 oder 404. Alle acht tiefen HTTP-Probes
erhielten Pfad und Query. `web.dev` lieferte fuer die www-Variante stabil 404,
waehrend die anderen fachlich relevanten Hostpaare konvergierten. Die
Run-77-Domain lieferte in drei Wiederholungen weiterhin zwei 404-Ziele; sechs
historische Produktaliase lieferten in zwei Wiederholungen jeweils initial
308 und final 200.

Da auf den acht organischen Implementierungen kein natuerlicher 5xx vorlag,
bleibt `tech.5xx_pages` konservativ `fixture_validated`. Ein lokaler
HTTP-Server deckte 200, 204, 301, 302, 307, 308, 400, 401, 403, 404, 405, 410,
429, 500, 502, 503 und 504 ab, ausserdem Redirectloops, Redirect auf 404/500,
abgebrochene Antworten, HEAD 405 bei GET 200 und 503-zu-200-Instabilitaet.

## Retry-, GET-/HEAD- und Availability-Semantik

Eine einzelne erfolgreiche deterministische Antwort wie 200, 301, 404 oder
410 genuegt ohne Instabilitaetssignal. 408, 429, 500, 502, 503, 504, Timeout
und typische Netzwerkabbrueche erhalten hoechstens einen zusaetzlichen
Versuch. Gleiche 5xx in zwei Versuchen sind `confirmed`; 503 gefolgt von 200
ist `transient`; ein einzelner Retry-Status ist `insufficient_evidence`; reine
DNS-/TLS-/Netzfehler sind `technical_error`. Nur `confirmed` kann ein
5xx-Website-Finding erzeugen.

Alle Seitenstatuspfade verwenden GET. HEAD darf ausserhalb dieser Checks als
Vorprobe dienen, entscheidet aber bei Abweichung nicht: HEAD 403/405 bei GET
200 ist kein Seitenfehler. Attempt-Historien enthalten Methode, Start- und
Finalstatus, Redirectkette, Final-URL, Content-Type, Dauer, Zeit und kompakten
Fehlertyp, niemals den Body.

## Belegte Korrekturen

- Retrybare 5xx wurden vor dem Persistieren verworfen. Nun wird jeder Versuch
  kompakt in Queue und Page gespeichert; ein dauerhafter 5xx bleibt
  auswertbar, ein spaeter erfolgreicher Retry bleibt als transient sichtbar.
- Hostkandidaten setzten `www.` auch vor echte Subdomains. `app.*` und
  `developer.*` erhalten nun nur ihre tatsaechlichen HTTP-/HTTPS-Varianten;
  www wird nur fuer eine registrierbare Apex-Domain erzeugt.
- Domainprobes behielten nur Finalstatus und Finalhost. Initialstatus,
  Redirectkette, Permanenz, Pfad-/Query-Erhalt, Hostrelation und kompakte
  Versuche sind nun getrennt vorhanden.
- Linkstatus-Hydration verlangte einen exakten Stringvergleich und verlor
  Fragmente; eine pauschale Normalisierung haette umgekehrt trailing-Slash-
  oder Query-Aliase verdeckt. Der Vergleich nutzt deshalb die authored
  Request-Identitaet: Fragmente sind irrelevant, Pfadslash und Query bleiben
  unterscheidbar.
- Interne Fehlerlinks ignorierten ungemessene Ziele und konnten still passen.
  Sie liefern nun bei fehlender notwendiger Zielmessung
  `insufficient_evidence`/`technical_error`, schliessen Assets und externe
  Ziele aus und zeigen Vorkommen sowie eindeutige Ziele getrennt.
- `redirect_pages` bestrafte die blosse Existenz eines Redirects. Es ist nun
  ein scorefreies Inventar; konkrete interne Redirectlinks und fehlerhafte
  Host-/Protokollkonsolidierung bleiben eigene Findings.
- Sitemap-Status nutzte nur den finalen Status. Ein initialer Redirect auf
  final 200 bleibt nun korrekt als nicht direkter 200-Sitemap-Eintrag sichtbar.
- Die Statusverteilung verdeckte initiale Redirects und stellte fehlende
  Messungen als Status 0 dar. Beide Statusverteilungen und technische Fehler
  sind nun getrennt.

Default-Severities wurden nicht global veraendert. Beim internen
4xx/5xx-Linkcheck wird die vorhandene High-Prioritaet nur bei mindestens drei
eindeutigen Zielen oder zehn Vorkommen angewandt; isolierte bestaetigte Ziele
werden Medium priorisiert. Reine Redirectinventare bleiben scorefrei.

## Run 77

Run 77 wurde ausschliesslich aus einer read-only Kopie rekonstruiert:

- Zwei 404-Seiten und drei interne Linkvorkommen auf diese zwei Ziele sind
  historisch und heute bestaetigt.
- Der urspruengliche Pass fuer `internal_links_to_3xx` war ein False Negative:
  neun Vorkommen auf sechs 308-Aliase wurden durch den finalen 200 verdeckt.
- `redirect_pages` enthielt zehn URLs, davon zwei `fressnapf.de`-Fremddaten.
  Der run-isolierte korrigierte Scope umfasst acht Run-77-URLs; als Inventar
  entsteht daraus kein eigener Scoreabzug.
- HTTP-zu-HTTPS, HTTPS-Erreichbarkeit und die Auswahl von www als kanonischem
  Host sind durch die gespeicherte Evidenz und heutige GETs bestaetigt.
- Der historische 5xx-Pass ist nur als negative Momentaufnahme lesbar. Der
  alte Run besitzt keine neue Attempt-Historie; sie wird nicht erfunden.
- Die historische Statusverteilung 2.047 final 200 und zwei final 404 bleibt
  erhalten, kann initiale Redirects aber nicht vollstaendig rekonstruieren.

Originalrun und produktive Datenbank wurden nicht veraendert.

## Grenzen

- DNS-, TLS-, Zertifikats- und WAF-Fehler koennen technisch klassifiziert,
  aber ohne unabhaengige Serverkontrolle nicht sicher dem Websitebetreiber
  zugerechnet werden.
- Ein bestaetigter CDN-5xx beweist die Clientantwort, nicht automatisch die
  fehlerhafte Origin-Komponente.
- Die Hostpruefung erzwingt weder Apex noch www. Internationalisierung,
  Migration und absichtlich getrennte Subdomains koennen Review benoetigen.
- Gezielte Audits bewerten nur geplante URLs. Statusinventar und Sitemapcheck
  sind kein Vollcrawlversprechen.
