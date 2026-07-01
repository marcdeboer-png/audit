# Fressnapf Screaming Frog Import

Place real Screaming Frog exports for the Fressnapf validation case in this folder.

This directory is for local/customer data and generated exports. Do not commit CSV/XLSX/ZIP files.

## Accepted Inputs

- A folder containing Screaming Frog CSV exports
- A ZIP containing Screaming Frog CSV exports
- Individual CSV paths passed to the importer

## Recommended Exports

- `internal_html.csv` or `internal_all.csv`
- `response_codes.csv`
- `page_titles.csv`
- `meta_descriptions.csv`
- `h1.csv`
- `h2.csv`
- `canonicals.csv`
- `directives.csv`
- `inlinks.csv`
- `outlinks.csv`
- `images.csv`
- `structured_data.csv`
- `hreflang.csv`
- `javascript.csv` or rendered/internal JavaScript exports
- PSI/CrUX exports, if available
- Header/security/request exports with cache/CDN/protocol headers, if available

## Supported Signal Families

The importer maps URL facts, titles, descriptions, headings, canonicals, directives, inlinks/outlinks, image alt data, structured data, hreflang, Open Graph, favicon/manifest, cache/CDN headers, resource hints, JS/CSS counts/bytes, and consent/tag-manager technical signals where the export columns are present.

## Run Import And Validation

After placing real exports here:

```bash
node scripts/prepare-fressnapf-sf-import.js --input reference-audits/fressnapf/screaming-frog --reference reference-audits/fressnapf/fressnapf-reference-audit.json --out reports/validation-fressnapf-original-sf-import
```

The script creates a real `screaming_frog_import` run, runs the same 91-point reference validation, and writes a Run 76 vs SF comparison when data is present.

If no real SF exports are present, the script writes `sf-import-not-found.md` and `sf-import-instructions.md` and does not create fake coverage.
