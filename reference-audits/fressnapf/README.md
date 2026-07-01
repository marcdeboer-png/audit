# Fressnapf Reference Audit

Place the manual OMfire! reference audit exports for the first validation case here.

Supported input formats:

- XLSX workbooks parsed locally via Office XML extraction
- CSV exported from Excel, one file per sheet if needed
- JSON reference audit files

Put the original workbook under `original/`. The `original/` folder and generated exports are ignored by Git and must not be committed.

Example CLI:

```bash
node scripts/prepare-fressnapf-reference.js --runId 76 --out reports/validation-fressnapf-original-run-76
```

Direct multi-CSV validation is also supported:

```bash
npm run validate:audit -- --runId 76 --reference reference-audits/fressnapf/original/01-overview.csv reference-audits/fressnapf/original/02-tech.csv --out reports/validation-fressnapf-original-run-76
```
