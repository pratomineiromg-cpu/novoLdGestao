# Local Private Data Policy

Date: 2026-09-04

Product: LidacomZap Gestao Inteligente

Pilot: Restaurante Prato Mineiro

## Policy

Git ignored does not mean unreadable. Files ignored by Git can still be opened by
shell globs, broad scans, local scripts, editor indexing, and automation agents.
Real files containing customer PII must not live inside the Git repository, even
when their suffix is ignored.

The official local private root is:

```text
LOCALAPPDATA/LidacomZap/private-data
```

Contact bootstrap private files belong under:

```text
LOCALAPPDATA/LidacomZap/private-data/contact-bootstrap
```

Code and documentation must not hardcode a user home directory. Local tooling may
accept absolute paths outside the repository for real input and output files.
Repository fixtures must be synthetic and should avoid private-data suffixes such
as `.local.json`, `.plan.json`, and `.report.json`.

## Validation Rules

Infrastructure validation may use file existence, resolved paths, length, and
filesystem hash equality for copy verification. It must not print, parse, or
inspect real private file content.

Agents and scanners must not read real private files. They may inspect path and
metadata only when validating storage placement or migration integrity.

PII backups are a separate future decision. No private customer data should be
sent to ChatGPT, AI Studio, GitHub, remote storage, or any provider integration as
part of this offline foundation.

## Incident Closure

Incident: a real local contact bootstrap manifest was inadvertently opened by a
broad local inspection command during F1B-07.

Observed: according to the execution report, no content was printed or committed.

Root cause: the real PII file was physically located inside the working tree.

Corrective action: the real PII file was moved outside the repository into the
official local private data root.

Preventive action: `npm run privacy:workspace:check` now performs a filename and
path based workspace guard for private local data files and generated artifacts.
