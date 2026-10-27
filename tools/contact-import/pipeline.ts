import {
  ContactImportPreview,
  ContactImportReport,
  ContactImportSource,
  ContactImportTechnicalReason,
  ContactImporter
} from '../../src/domain/types';
import { createId } from '../../src/utils/id';
import { BootstrapManifest } from '../contact-bootstrap/types';
import { validateManifest } from '../contact-bootstrap/validator';
import { parseCsv } from './csvParser';
import { ContactImportError } from './errors';
import {
  deduplicateCandidates,
  mapCsvRowToContactCandidate,
  resolveExplicitColumnMapping,
  resolveGoogleContactsCsvMapping
} from './mapper';
import {
  LocalContactImportOptions,
  LocalContactImportResult,
  NormalizedImportCandidate,
  SanitizedImportPreview
} from './types';

const DEFAULT_PROJECT_ID = 'lidacomzap-gestao-inteligente';
const DEFAULT_TENANT_ID = 't-pratomineiro';
const OPAQUE_IMPORT_ID = /^import-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sourceForInputKind(inputKind: LocalContactImportOptions['inputKind']): ContactImportSource {
  if (inputKind === 'CSV') return 'CSV';
  if (inputKind === 'GOOGLE_CONTACTS_CSV_EXPORT') return 'GOOGLE_CONTACTS';
  throw new ContactImportError('XLSX_NOT_ENABLED');
}

function resolveOperationId(operationId: string | undefined): string {
  const resolved = operationId ?? createId('import');
  if (!OPAQUE_IMPORT_ID.test(resolved)) {
    throw new ContactImportError('INVALID_OPERATION_ID');
  }
  return resolved;
}

function buildBootstrapManifest(
  candidates: readonly NormalizedImportCandidate[],
  operationId: string,
  projectId: string,
  tenantId: string,
  now: Date
): BootstrapManifest {
  const timestamp = now.toISOString();
  return {
    projectId,
    tenantId,
    operationId,
    contacts: candidates.map(({ candidate, canonicalPhone }) => ({
      id: createId('contact'),
      tenantId,
      name: candidate.contact.name,
      phone: canonicalPhone,
      tags: candidate.contact.tags,
      notes: candidate.contact.notes,
      createdAt: timestamp,
      updatedAt: timestamp
    }))
  };
}

function toSanitizedPreview(
  source: ContactImportSource,
  inputKind: LocalContactImportOptions['inputKind'],
  report: ContactImportReport
): SanitizedImportPreview {
  return {
    status: 'PASS',
    source,
    inputKind,
    operationId: report.operationId,
    importId: report.importId,
    rowsFound: report.found,
    validRows: report.valid,
    invalidRows: report.rejected,
    duplicateRows: report.duplicate,
    manifestCandidates: report.valid,
    errorCodes: report.technicalReasons.map((reason) => reason.code)
  };
}

/**
 * Pure local CSV import. Invalid records are rejected, counted, and excluded;
 * no value is guessed or repaired beyond the approved canonicalPhone routine.
 */
export function runLocalContactImport(
  content: string,
  options: LocalContactImportOptions
): LocalContactImportResult {
  const source = sourceForInputKind(options.inputKind);
  const projectId = options.projectId ?? DEFAULT_PROJECT_ID;
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
  const operationId = resolveOperationId(options.operationId);
  const importId = createId('contact-import');
  const now = options.now ?? new Date();
  const parsed = parseCsv(content);
  const mapping = options.inputKind === 'GOOGLE_CONTACTS_CSV_EXPORT'
    ? resolveGoogleContactsCsvMapping(parsed.headers)
    : resolveExplicitColumnMapping(parsed.headers, options.mapping);

  const mapped: NormalizedImportCandidate[] = [];
  let invalidRows = 0;
  for (const row of parsed.rows) {
    const candidate = mapCsvRowToContactCandidate(row, mapping, tenantId);
    if (!candidate) {
      invalidRows += 1;
      continue;
    }
    mapped.push(candidate);
  }

  const { unique, duplicateRows } = deduplicateCandidates(mapped);
  const technicalReasons: ContactImportTechnicalReason[] = [];
  if (invalidRows > 0) {
    technicalReasons.push({ code: 'INVALID_RECORD', count: invalidRows });
  }
  if (duplicateRows > 0) {
    technicalReasons.push({ code: 'DUPLICATE_CONTACT', count: duplicateRows });
  }

  const report: ContactImportReport = {
    operationId,
    importId,
    source,
    found: parsed.rows.length,
    valid: unique.length,
    rejected: invalidRows,
    duplicate: duplicateRows,
    technicalReasons,
    startedAt: now,
    completedAt: now
  };
  const internalPreview: ContactImportPreview = {
    candidates: unique.map((candidate) => candidate.candidate),
    report
  };
  const manifest = buildBootstrapManifest(unique, operationId, projectId, tenantId, now);

  // Preserve all F1B-05A guards before a manifest can leave this tool.
  validateManifest(manifest);

  return {
    sanitizedPreview: toSanitizedPreview(source, options.inputKind, report),
    internalPreview,
    manifest
  };
}

/** Implements the F1B-05B importer boundary without acquiring any external data. */
export class LocalCsvContactImporter implements ContactImporter {
  readonly source: ContactImportSource;

  constructor(private readonly options: LocalContactImportOptions) {
    this.source = sourceForInputKind(options.inputKind);
  }

  preview(input: unknown): ContactImportPreview {
    if (typeof input !== 'string') {
      throw new ContactImportError('UNSUPPORTED_INPUT');
    }
    return runLocalContactImport(input, this.options).internalPreview;
  }
}
