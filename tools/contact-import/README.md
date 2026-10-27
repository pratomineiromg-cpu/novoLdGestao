# Local Contact Import Tool

This F1B-05C tool prepares contact manifests locally. It reads a local CSV,
normalizes it with the approved F1B-05A phone routine, rejects invalid records,
deduplicates by canonical phone, returns a sanitized preview, and can write a
bootstrap-compatible local manifest.

It has no transport code, service SDK, OAuth flow, Firebase/Firestore access, or
bootstrap apply mode. The tool never invokes the bootstrap planner or `--apply`.

## Sources

- `CSV` requires an explicit mapping file containing `name` and `phone` headers.
- `GOOGLE_CONTACTS_CSV_EXPORT` is a manually exported CSV preset. It uses `Name`
  when present (otherwise given/family name columns) and selects the first
  non-empty canonical value among exported phone columns.
- `XLSX` is intentionally fail-closed with `XLSX_NOT_ENABLED`. No local XLSX
  parser dependency exists in `package.json`; the adapter boundary is ready for a
  future dependency decision.

CSV supports UTF-8 with optional BOM, comma or semicolon headers, CRLF/LF, blank
rows, quoted cells, escaped quotes, and separators inside quoted cells. It is a
small local parser, not a generic spreadsheet engine.

## Commands

Preview only, printing counts/codes and no contact values:

```sh
npm run contacts:import:preview -- --input tools/contact-import/fixtures/contacts-fixture.csv --source CSV --mapping-file tools/contact-import/fixtures/csv-mapping.json
```

Create a local manifest and optional sanitized report:

```powershell
$privateDir = Join-Path $env:LOCALAPPDATA 'LidacomZap\private-data\contact-bootstrap'
npm run contacts:import:manifest -- --input tools/contact-import/fixtures/contacts-fixture.csv --source CSV --mapping-file tools/contact-import/fixtures/csv-mapping.json --output (Join-Path $privateDir 'contacts.local.json') --report (Join-Path $privateDir 'contacts.report.json')
```

Manifests containing contacts must use `.local.json`. Sanitized reports must use
`.report.json`. Real outputs must be written outside the repository. The tool
refuses generic JSON output paths for manifests and refuses private-data outputs
inside the Git root.

## Bootstrap compatibility

The manifest uses the exact F1B-05A `BootstrapManifest` shape and is validated by
the existing manifest validator before it can be written. It preserves project and
tenant guards, opaque generated contact IDs, ISO timestamps, canonical phone
deduplication, and create-only planner semantics.

The next local-only step, when needed, is explicitly separate:

```sh
npm run bootstrap:contacts:plan -- --input <external-private-path>/contacts.local.json --output <external-private-path>/contacts.plan.json
```

This creates a plan only. F1B-05A still rejects `--apply`.

## Privacy model

The public CLI result and optional report contain only source, opaque operation and
import IDs, counts, technical reason codes, and write-status flags. They do not
contain raw rows, names, phone values, emails, addresses, notes, or rejected-row
content. Invalid and duplicate rows are excluded rather than guessed or repaired.

Google Contacts CSV is a local file format only. A future Google People API adapter
would be a separate, explicitly authorized phase. The same applies to UI upload,
preview, controlled confirmation, and any future provider ingestion.
