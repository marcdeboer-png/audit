# HTTP-, Host- und Security-Header-Validierung v1

Stand: 23. Juli 2026

Audit-Standard: `audit-standard-v1`

Header-Policy: `http-header-policy-v1`

Protokollmessung: `http-protocol-negotiation-v1`

Hosterkennung: `domain-host-detection-v2`

## Produktionsinventar und ID-Zuordnung

Batch 12.3 erweitert keine Checkanzahl. Die Auftragsnamen werden auf die
aktiven Produktions-IDs abgebildet:

| Auftragsbegriff | Aktiver Produktionscheck |
| --- | --- |
| `host.http_https_redirect` | `tech.http_to_https_redirect` |
| `host.host_consistency`, `host.www_consistency` | `tech.www_non_www_consistency` |
| `tech.http_compression` | `tech.compression_header` |
| `tech.http2_http3` | `tech.http_version_support` |
| `tech.cache_headers` | `tech.cache_control_header`, `tech.cdn_cache_signals` |

`tech.redirect_chain`, `tech.redirect_loop` und `tech.redirect_hops` sind keine
eigenständigen aktiven Checks der 137er-Registry. Kette, Schleife, Hopzahl,
Status, Hostwechsel und Stabilität sind versionierte Subgründe des scorefreien
Inventars `tech.redirect_pages` sowie der beiden Hostchecks.

COEP, COOP, CORP, `Server` und `X-Powered-By` sind ebenfalls keine separaten
aktiven Produktionschecks. Sie werden ohne Technologiespekulation als kompakte
Header-Subevidence gespeichert; daraus entsteht weder ein impliziter Check noch
ein Scoreabzug.

| Check-ID | Soll-Severity | Nutzung | Score | Validierungsstatus |
| --- | --- | --- | --- | --- |
| `tech.https_reachable` | High | `fully_automated` | scorewirksam bei bestätigtem Websitefehler | `validated_with_limits` |
| `tech.http_to_https_redirect` | Medium | `fully_automated` | scorewirksam | `validated_with_limits` |
| `tech.www_non_www_consistency` | Medium | `fully_automated` | scorewirksam | `validated_with_limits` |
| `tech.redirect_pages` | Info | `diagnostic_only` | scorefrei | `cross_domain_validated` |
| `tech.content_security_policy` | Low/Medium | `automated_with_limits` | scorewirksam | `validated_with_limits` |
| `tech.permissions_policy` | Low/Medium | `automated_with_limits` | scorewirksam | `validated_with_limits` |
| `tech.referrer_policy` | Low | `fully_automated` | scorewirksam | `validated_with_limits` |
| `tech.x_content_type_options` | Low | `fully_automated` | scorewirksam | `validated_with_limits` |
| `tech.x_frame_options` | Low/Medium | `automated_with_limits` | scorewirksam | `validated_with_limits` |
| `tech.hsts_header` | Low | `automated_with_limits` | scorewirksam | `validated_with_limits` |
| `tech.compression_header` | Low | `automated_with_limits` | scorewirksam | `validated_with_limits` |
| `tech.http_version_support` | Low | `fully_automated` | scorewirksam | `validated_with_limits` |
| `tech.cache_control_header` | Low/Medium | `automated_with_limits` | scorewirksam | `validated_with_limits` |
| `tech.cdn_cache_signals` | Low/Medium | `automated_with_limits` | mit Cache-Root-Cause dedupliziert | `validated_with_limits` |

## Umgesetzte Semantik

### HTTP, TLS und Host

- Hosterkennung und Checks verwenden GET. Initialer und finaler Status,
  vollständige Redirectkette, finaler Host, Pfad, Query, Hopzahl und Fehlerart
  bleiben getrennt.
- Die HTTPS-Messung speichert TLS-Verbindung, Autorisierung,
  Zertifikatsgültigkeit, Hostabdeckung und ausgehandeltes ALPN-Protokoll.
  Zertifikatsfehler sind von lokalen DNS-, Timeout- und Netzwerkfehlern
  getrennt.
- HTTP muss unmittelbar per 301 oder 308 auf den kanonischen HTTPS-Host
  konsolidieren. Temporäre Redirects, mehrere Hops, Schleifen, falscher Host
  sowie Pfad- oder Queryverlust sind eigenständige Subgründe.
- Apex/www wird nur bei einem fachlich vorhandenen Paar geprüft. Echte
  Subdomainprojekte erhalten `not_applicable`. Normales Routing auf dem bereits
  kanonischen Host wird nicht als www/Apex-Fehler interpretiert.
- Nach dem Crawl werden deterministisch bis zu fünf unterschiedliche
  öffentliche Seitentypen und zusätzlich eine vorhandene öffentliche
  Query-URL auf den verfügbaren Originvarianten geprüft. Private, Login-,
  Such-, Admin-, Checkout- und unbekannte synthetische Pfade werden dafür nicht
  erfunden.

### Security-Header

- CSP unterscheidet enforced, Report-Only, Syntaxfehler, unvollständige
  Resource-Protection und erheblich geschwächte ausführbare Inhalte.
  `unsafe-inline` ist nur bei fehlendem brauchbarem Nonce-/Hash-Modell ein
  Medium-Signal. Eine reine `frame-ancestors`-Policy schützt Frames, erfüllt
  aber nicht den vollständigen CSP-Check.
- Permissions-Policy parst Direktiven, Klammer- und Allowlist-Syntax. Fehlend
  oder ungültig ist Low; ein Wildcard-Grant für definierte sensible
  Fähigkeiten ist Medium.
- Referrer-Policy behandelt `strict-origin-when-cross-origin` als empfohlenes
  Niveau. Andere kontrollierte gültige Policies bestehen mit eigener
  Qualitätsstufe. `unsafe-url`, `no-referrer-when-downgrade`, ungültig oder
  fehlend schlagen fehl.
- Beim Frame-Schutz hat eine enforced CSP-`frame-ancestors`-Direktive Vorrang.
  Dadurch entsteht kein doppeltes Finding neben X-Frame-Options.
- X-Content-Type-Options besteht ausschließlich mit `nosniff`.
- COEP, COOP und CORP werden als versionierte Subevidence geparst. Fehlende,
  widersprüchliche, permissive und tatsächlich schützende Werte bleiben
  unterscheidbar; da die 137er-Registry hierfür keine eigenen aktiven Checks
  enthält, entsteht daraus kein implizites Finding.
- HSTS wird nur auf HTTPS bewertet. `max-age` muss valide sein und den aktuell
  versionierten Sechsmonatswert erreichen. `includeSubDomains` und `preload`
  bleiben zusätzliche Qualitätsmerkmale.
- Mehrfachwerte, Widersprüche und fehlende Headerprovenienz werden explizit
  ausgewiesen. Unvollständige Evidence kann kein Pass sein.

### HTTP-Infrastruktur

- Kompression gilt für ausreichend große HTML-, CSS-, JavaScript-, JSON-,
  XML- und SVG-Antworten. `gzip`, `br` und `zstd` gelten als unterstützt.
  Binärformate und kleinere Antworten sind `not_applicable`; die aktuell
  versionierte Mindestgröße ist keine unveränderliche Fachregel.
- Cachebewertung verwendet die effektive Policy aus Cache-Control, Expires,
  ETag und Last-Modified. Statische Ressourcen mit `no-store`, `no-cache`,
  `max-age=0` oder ohne Policy/Validator sind Low. HTML-`no-cache` oder
  HTML-`no-store` ist ohne zusätzliche Dynamikklassifikation kein
  automatischer Fail.
- CDN-, Via-, Age- und Vendorheader sind nur unterstützende Evidence. Der
  Check besteht nicht deshalb, weil ein CDN-Header vorhanden ist.
- HTTP/2 wird über echte TLS-ALPN-Verhandlung belegt. Gespeicherte Strings oder
  beliebige Header reichen nicht. HTTP/3 bleibt positiv sichtbar, ist aber
  derzeit keine Pflicht.

## Root-Cause-Zuordnung

| Root Cause | Mitglieder |
| --- | --- |
| `host.https_transport` | `tech.https_reachable` |
| `host.redirect_configuration` | `tech.http_to_https_redirect` |
| `host.canonical_host_configuration` | `tech.www_non_www_consistency` |
| `http_protocol.negotiation` | `tech.http_version_support` |
| `http_compression.configuration` | `tech.compression_header` |
| `http_cache.configuration` | `tech.cache_control_header`, `tech.cdn_cache_signals` |
| `security_headers.csp` | `tech.content_security_policy` |
| `security_headers.permissions_policy` | `tech.permissions_policy` |
| `security_headers.referrer_policy` | `tech.referrer_policy` |
| `security_headers.content_type_protection` | `tech.x_content_type_options` |
| `security_headers.frame_protection` | `tech.x_frame_options` |
| `security_headers.hsts` | `tech.hsts_header` |

Die Cacheperspektiven teilen absichtlich denselben Root Cause. Headerfehler
werden außerdem je gemeinsamer Konfiguration statt pro URL voll belastet.
`tech.redirect_pages` bleibt unabhängig von seiner Inventargröße scorefrei.

## Reale domainübergreifende Gegenprüfung

Die unabhängige Referenzmessung erfolgte seriell per öffentlichem
`curl`-GET mit Zertifikatsprüfung, vollständiger Redirectkette und
`--compressed`. Es wurden keine Websites verändert und keine Blockade
umgangen. Rohheader und kompakte Protokolle lagen ausschließlich unter
`/tmp/http-host-security-validation-v1/`.

| Domain/Architektur | HTTP/Host-Referenz | Header-/Protokollreferenz |
| --- | --- | --- |
| `github.com` | direkter permanenter HTTP→HTTPS-Hop; www konsolidiert | HTTP/2; CSP, HSTS, Referrer, nosniff und Frame-Schutz positiv |
| `cloudflare.com` | Apex→www permanent | HTTP/2; HSTS/Permissions/Referrer/nosniff positiv; breite CSP-Ausführungsfreigaben als Medium erkannt |
| `mozilla.org` | HTTP-Kette enthält temporären Hop; kanonisches www mit Locale-Routing | HTTP/2; CSP/HSTS/Referrer/nosniff/Frame-Schutz vorhanden |
| `react.dev` | direkter permanenter HTTP→HTTPS-Hop | HTTP/2 und HSTS positiv; mehrere Security-Header fehlen |
| `nextjs.org` | direkter permanenter HTTP→HTTPS-Hop | HTTP/2; HSTS/Referrer/nosniff/Frame-Schutz positiv; CSP-Schwächung sichtbar |
| `marcdeboer.de` | direkter permanenter HTTP→HTTPS-Hop; www konsolidiert | HTTP/2 und gzip; Security-Header fehlen |
| `www.ikea.com` | direkter permanenter HTTP→HTTPS-Hop | HTTP/2; CSP/HSTS/Frame-Schutz positiv |
| `app.uniswap.org` | echte Subdomain, daher keine erfundene www-Pflicht | HTTP/2/HSTS/Frame-Schutz; enforced CSP schützt nur Frames, vollständige Policy ist Report-Only |

Alle acht Livehosts verhandelten HTTP/2. Der HTTP/1.1-only-Negativfall, fehlende
Kompression, Headerkonflikte, Redirectloop, Zertifikatsfehler und technische
Availability-Zustände sind deshalb kontrolliert fixture-validiert und nicht
als realer Positivfall ausgegeben.

## Run 77

Run 77 (`trinkgut-zierles.de`, 17. Juli 2026) wurde aus einer temporären Kopie
neu berechnet. Das Original blieb unverändert.

- CSP, Permissions-Policy, Referrer-Policy, nosniff, effektiver Frame-Schutz,
  HSTS und Kompression wurden aus vollständigen gespeicherten Final-Headern
  erneut bestätigt.
- 19 eindeutige statische Ressourcen besaßen eine ausdrücklich
  uncachebare Policy. Die frühere HTML-Presence-Logik hatte diese
  Ressourcenursache nicht bewertet; die neue Bewertung korrigiert damit einen
  historischen False Negative. HTML-`no-store` selbst wurde nicht als Fehler
  gewertet.
- HTTPS-, HTTP→HTTPS-, www/Apex- und HTTP-Versions-Pässe lassen sich historisch
  nicht nach dem neuen Standard bestätigen: Zertifikat/ALPN sowie vollständige
  initiale Host- und Pfadprovenienz fehlen. Die Neubewertung lautet
  `insufficient_evidence`, nicht Fail.
- Das frühere Redirectinventar basierte bei den betroffenen Altzeilen nicht auf
  vollständig gespeicherten initialen Status- und Kettenfakten. Es wird heute
  nicht als vollständiger Pass oder Fail rekonstruiert.

## Regression und bekannte Grenzen

`tests/http-host-security-standard.test.js` enthält Parser-, Check- und
Infrastrukturfixtures für Pass, Low/Medium-Fail, `not_applicable`,
`insufficient_evidence`, technische Fehler, Mehrfach-/Widerspruchsheader,
HTTP/1.1 versus HTTP/2, Host-/Queryverlust, Redirectloop und
Zertifikatsfehler. Bestehende HTTP-, Export-, Detail-, Registry-,
Run-Isolations- und historische Tests sichern die Ausgabeparität.

Bekannte Grenzen:

- Der Node-TLS-Probe verhandelt derzeit HTTP/2 oder HTTP/1.1. HTTP/3 wird bis
  zu einer QUIC-Messung nur additiv über Alt-Svc inventarisiert.
- CSP-, Permissions- und Frame-Policy können statisch bewertet werden; die
  Funktionsverträglichkeit jeder Anwendung bleibt außerhalb dieser
  Headerprüfung.
- Resource-Checks verlangen gespeicherte Netzwerkheader. Fehlen sie, entsteht
  `insufficient_evidence` statt eines Site-Passes.
- Die repräsentative Pfadprüfung deckt vorhandene öffentliche Seitentypen
  deterministisch ab, beweist aber keine unbekannten individuellen
  Edge-Routingregeln.
