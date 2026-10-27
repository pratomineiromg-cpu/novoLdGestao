import {
  ContactImportCandidate,
  ContactImportPreview,
  ContactImportReport,
  ContactImportSource
} from '../../src/domain/types';
import { BootstrapManifest } from '../contact-bootstrap/types';

export type LocalContactImportInputKind =
  | 'CSV'
  | 'GOOGLE_CONTACTS_CSV_EXPORT'
  | 'XLSX';

export type CsvDelimiter = ',' | ';';

export interface ParsedCsvRow {
  rowNumber: number;
  values: Record<string, string>;
}

export interface ParsedCsvFile {
  delimiter: CsvDelimiter;
  headers: string[];
  rows: ParsedCsvRow[];
}

/** Explicit mapping is required for ordinary CSV input. */
export interface ExplicitColumnMapping {
  name: string;
  phone: string;
  email?: string;
  tags?: string;
}

export interface ResolvedColumnMapping {
  nameColumns: string[];
  phoneColumns: string[];
  tagsColumn?: string;
}

export interface LocalContactImportOptions {
  inputKind: LocalContactImportInputKind;
  mapping?: ExplicitColumnMapping;
  projectId?: string;
  tenantId?: string;
  operationId?: string;
  now?: Date;
}

export interface NormalizedImportCandidate {
  candidate: ContactImportCandidate;
  canonicalPhone: string;
}

/** The only preview shape permitted to leave the local processing boundary. */
export interface SanitizedImportPreview {
  status: 'PASS';
  source: ContactImportSource;
  inputKind: LocalContactImportInputKind;
  operationId: string;
  importId: string;
  rowsFound: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  manifestCandidates: number;
  errorCodes: readonly string[];
}

export interface LocalContactImportResult {
  sanitizedPreview: SanitizedImportPreview;
  /** Internal-only candidate representation. CLI output must never print this. */
  internalPreview: ContactImportPreview;
  manifest: BootstrapManifest;
}

export interface LocalContactImportAnalysis {
  source: ContactImportSource;
  report: ContactImportReport;
  candidates: NormalizedImportCandidate[];
}
