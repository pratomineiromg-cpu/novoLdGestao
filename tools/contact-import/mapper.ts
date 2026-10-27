import { ContactImportCandidate } from '../../src/domain/types';
import { canonicalPhone } from '../contact-bootstrap/validator';
import { ContactImportError } from './errors';
import {
  ExplicitColumnMapping,
  NormalizedImportCandidate,
  ParsedCsvRow,
  ResolvedColumnMapping
} from './types';

function requireKnownHeaders(headers: string[], requested: readonly string[]): void {
  if (requested.some((header) => !headers.includes(header))) {
    throw new ContactImportError('MAPPING_INVALID');
  }
}

export function resolveExplicitColumnMapping(
  headers: string[],
  mapping: ExplicitColumnMapping | undefined
): ResolvedColumnMapping {
  if (!mapping) {
    throw new ContactImportError('MAPPING_REQUIRED');
  }
  if (!mapping.name || !mapping.phone) {
    throw new ContactImportError('MAPPING_INVALID');
  }
  const requested = [mapping.name, mapping.phone, mapping.email, mapping.tags]
    .filter((header): header is string => Boolean(header));
  requireKnownHeaders(headers, requested);
  return {
    nameColumns: [mapping.name],
    phoneColumns: [mapping.phone],
    tagsColumn: mapping.tags
  };
}

/**
 * Manual Google Contacts CSV exports may include more than one phone column.
 * The mapper chooses the first non-empty canonical phone in header order.
 */
export function resolveGoogleContactsCsvMapping(headers: string[]): ResolvedColumnMapping {
  const nameColumns = headers.includes('Name')
    ? ['Name']
    : ['Given Name', 'Family Name'].filter((header) => headers.includes(header));
  const phoneColumns = headers.filter((header) =>
    /^Phone(?:\s+\d+)?(?:\s+-\s+Value)?$/i.test(header)
  );

  if (nameColumns.length === 0 || phoneColumns.length === 0) {
    throw new ContactImportError('MAPPING_INVALID');
  }

  return { nameColumns, phoneColumns };
}

function toTags(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split('|')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function mapCsvRowToContactCandidate(
  row: ParsedCsvRow,
  mapping: ResolvedColumnMapping,
  tenantId: string
): NormalizedImportCandidate | undefined {
  const name = mapping.nameColumns
    .map((column) => row.values[column]?.trim() ?? '')
    .filter(Boolean)
    .join(' ')
    .trim();

  if (name.length === 0) {
    return undefined;
  }

  let canonical = '';
  for (const column of mapping.phoneColumns) {
    const sourcePhone = row.values[column]?.trim() ?? '';
    if (sourcePhone.length === 0) continue;
    const candidate = canonicalPhone(sourcePhone);
    if (candidate.length > 0) {
      canonical = candidate;
      break;
    }
  }

  if (canonical.length === 0) {
    return undefined;
  }

  const candidate: ContactImportCandidate = {
    contact: {
      tenantId,
      name,
      phone: canonical,
      tags: toTags(mapping.tagsColumn ? row.values[mapping.tagsColumn] : undefined),
      notes: ''
    },
    identities: []
  };

  return { candidate, canonicalPhone: canonical };
}

export function deduplicateCandidates(
  candidates: readonly NormalizedImportCandidate[]
): { unique: NormalizedImportCandidate[]; duplicateRows: number } {
  const phones = new Set<string>();
  const unique: NormalizedImportCandidate[] = [];
  let duplicateRows = 0;

  for (const candidate of candidates) {
    if (phones.has(candidate.canonicalPhone)) {
      duplicateRows += 1;
      continue;
    }
    phones.add(candidate.canonicalPhone);
    unique.push(candidate);
  }

  return { unique, duplicateRows };
}
