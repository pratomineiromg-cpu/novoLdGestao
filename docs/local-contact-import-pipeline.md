# Privacy-Safe Local Contact Import Pipeline

F1B-05C introduces a local-first import path:

```text
local CSV file
  -> parser
  -> explicit mapping or Google Contacts CSV preset
  -> approved canonical phone normalization
  -> validation and deduplication
  -> sanitized preview
  -> external private BootstrapManifest (*.local.json)
  -> existing F1B-05A planner
```

The pipeline is intentionally offline. It contains no network client, no channel
adapter, no Firebase/Firestore operation, no OAuth, no Google People API, and no
bootstrap apply behavior.

## Supported inputs

Regular `CSV` uses an explicit name/phone mapping. Optional email and tags columns
may be declared, but the current Contact/bootstrap schema only consumes name,
phone, and tags. The importer does not extend Contact with input-only fields.

`GOOGLE_CONTACTS_CSV_EXPORT` supports CSV exported manually from Google Contacts.
It is not a Google API integration. The preset chooses the first valid canonical
phone among the exported phone columns and produces one bootstrap Contact candidate
per input row. Multiple identities and People API acquisition remain future work.

CSV parsing supports UTF-8 BOM, headers, quoted fields, embedded separators,
escaped quotes, blank lines, CRLF/LF, commas, and semicolons. XLSX is foundation
ready but not implemented because this repository has no approved local XLSX
library; the input kind fails explicitly with `XLSX_NOT_ENABLED`.

## Privacy and output safety

Raw source rows exist only in process memory while the local command runs. Console
output and `.report.json` files expose only counts, source, opaque operation/import
IDs, error codes, and write-status flags. They never contain names, phone values,
emails, addresses, notes, raw rows, or rejected content.

Contact IDs and operation IDs are generated with the existing random UUID helper;
they do not derive from any imported value. Real manifests must use `.local.json`;
the tool refuses generic JSON manifest outputs and refuses private-data outputs
inside the Git root. Real `.local.json`, `.plan.json`, and `.report.json` files
must be written under the user's local private data root, not inside the
repository.

## Integration boundary

The manifest builder produces the existing F1B-05A `BootstrapManifest` and invokes
its validator before writing. It preserves project/tenant guards and leaves planner
create-only behavior unchanged. Planning remains a separate local command, and
`--apply` remains disabled.

Future platform UI work may expose local upload, mapping selection, a sanitized
preview, and a controlled manifest download/write flow. Any real Google Contacts,
XLSX dependency, Firestore persistence, or channel-provider import requires a new
approved phase.
