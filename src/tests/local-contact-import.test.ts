import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNoApplyFlag } from '../../tools/contact-bootstrap/cli';
import { generatePlan } from '../../tools/contact-bootstrap/planner';
import { canonicalPhone, validateManifest } from '../../tools/contact-bootstrap/validator';
import { parseCsv } from '../../tools/contact-import/csvParser';
import { ContactImportError } from '../../tools/contact-import/errors';
import { resolveGoogleContactsCsvMapping } from '../../tools/contact-import/mapper';
import { resolveSafeManifestOutputPath, resolveSafeReportOutputPath } from '../../tools/contact-import/output';
import { LocalCsvContactImporter, runLocalContactImport } from '../../tools/contact-import/pipeline';
import { ExplicitColumnMapping } from '../../tools/contact-import/types';

const mapping: ExplicitColumnMapping = {
  name: 'Name',
  phone: 'Phone',
  tags: 'Tags'
};
const fixedNow = new Date('2026-09-04T12:00:00.000Z');
const opaqueOperationId = 'import-12345678-1234-1234-1234-1234567890ab';

function runCsv(content: string) {
  return runLocalContactImport(content, {
    inputKind: 'CSV',
    mapping,
    operationId: opaqueOperationId,
    now: fixedNow
  });
}

describe('F1B-05C privacy-safe local contact import pipeline', () => {
  it('parses a valid comma-separated CSV using explicit mapping', () => {
    const result = runCsv('Name,Phone,Tags\nCliente Teste Alfa,+55 11 90000-0001,fixture');

    expect(result.sanitizedPreview).toMatchObject({
      source: 'CSV',
      rowsFound: 1,
      validRows: 1,
      invalidRows: 0,
      duplicateRows: 0,
      manifestCandidates: 1
    });
  });

  it('supports UTF-8 BOM and CRLF', () => {
    const parsed = parseCsv('\ufeffName;Phone\r\nCliente Teste Alfa;+55 11 90000-0001\r\n');

    expect(parsed.delimiter).toBe(';');
    expect(parsed.headers).toEqual(['Name', 'Phone']);
    expect(parsed.rows).toHaveLength(1);
  });

  it('supports LF, semicolon, quoted separators, and blank lines', () => {
    const parsed = parseCsv('Name;Phone;Tags\n\n"Cliente; Teste";"+55 11 90000-0001";"fixture;especial"\n');

    expect(parsed.delimiter).toBe(';');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].values.Name).toBe('Cliente; Teste');
    expect(parsed.rows[0].values.Tags).toBe('fixture;especial');
  });

  it('supports escaped quotes inside a quoted CSV field', () => {
    const parsed = parseCsv('Name,Phone\n"Cliente ""Teste""",+55 11 90000-0001');

    expect(parsed.rows[0].values.Name).toBe('Cliente "Teste"');
  });

  it('fails closed for malformed CSV quotes and missing explicit mappings', () => {
    expect(() => parseCsv('Name,Phone\n"Cliente Teste,+55 11 90000-0001'))
      .toThrow(ContactImportError);
    expect(() => runLocalContactImport('Name,Phone\nCliente Teste,+55 11 90000-0001', {
      inputKind: 'CSV',
      now: fixedNow
    })).toThrow('MAPPING_REQUIRED');
  });

  it('uses the Google Contacts CSV preset and chooses the first valid phone column', () => {
    const result = runLocalContactImport(
      'Name,Phone 1 - Value,Phone 2 - Value\nCliente Google Teste,,+55 11 90000-0011',
      {
        inputKind: 'GOOGLE_CONTACTS_CSV_EXPORT',
        operationId: opaqueOperationId,
        now: fixedNow
      }
    );

    expect(result.sanitizedPreview.source).toBe('GOOGLE_CONTACTS');
    expect(result.manifest.contacts[0].phone).toBe(canonicalPhone('+55 11 90000-0011'));
  });

  it('rejects a Google Contacts CSV shape with no recognizable phone header', () => {
    expect(() => resolveGoogleContactsCsvMapping(['Name', 'E-mail 1 - Value']))
      .toThrow('MAPPING_INVALID');
  });

  it('uses the exact bootstrap phone canonicalization rather than a second rule', () => {
    const sourcePhone = '+55 (11) 90000-0001';
    const result = runCsv(`Name,Phone,Tags\nCliente Teste Alfa,"${sourcePhone}",fixture`);

    expect(result.manifest.contacts[0].phone).toBe(canonicalPhone(sourcePhone));
  });

  it('counts missing or invalid phones as rejected without producing a candidate', () => {
    const result = runCsv('Name,Phone,Tags\nCliente Sem Telefone,,fixture\nCliente Telefone Inválido,sem-telefone,fixture');

    expect(result.sanitizedPreview).toMatchObject({
      rowsFound: 2,
      validRows: 0,
      invalidRows: 2,
      duplicateRows: 0,
      manifestCandidates: 0,
      errorCodes: ['INVALID_RECORD']
    });
  });

  it('deduplicates formatted variants using canonical phone and never exposes its value in the preview', () => {
    const result = runCsv('Name,Phone,Tags\nCliente Teste Alfa,+55 11 90000-0001,fixture\nCliente Teste Beta,5511900000001,fixture');
    const previewText = JSON.stringify(result.sanitizedPreview);

    expect(result.sanitizedPreview).toMatchObject({ validRows: 1, duplicateRows: 1 });
    expect(previewText).not.toContain('5511900000001');
    expect(previewText).not.toContain('Cliente Teste Alfa');
  });

  it('uses opaque generated contact and import IDs', () => {
    const result = runCsv('Name,Phone,Tags\nCliente Teste Alfa,+55 11 90000-0001,fixture');

    expect(result.sanitizedPreview.operationId).toBe(opaqueOperationId);
    expect(result.sanitizedPreview.importId).toMatch(/^contact-import-[0-9a-f-]{36}$/i);
    expect(result.manifest.contacts[0].id).toMatch(/^contact-[0-9a-f-]{36}$/i);
    expect(result.manifest.contacts[0].id).not.toContain('Cliente');
  });

  it('keeps the import report and default preview free from raw contact fields', () => {
    const result = runCsv('Name,Phone,Tags\nCliente Teste Alfa,+55 11 90000-0001,fixture');
    const reportText = JSON.stringify(result.internalPreview.report);
    const previewKeys = Object.keys(result.sanitizedPreview);

    expect(previewKeys).not.toContain('name');
    expect(previewKeys).not.toContain('phone');
    expect(previewKeys).not.toContain('email');
    expect(previewKeys).not.toContain('rawRow');
    expect(reportText).not.toContain('Cliente Teste Alfa');
    expect(reportText).not.toContain('5511900000001');
  });

  it('builds the existing bootstrap manifest and preserves create-only planner semantics', () => {
    const result = runCsv('Name,Phone,Tags\nCliente Teste Alfa,+55 11 90000-0001,fixture');
    const contacts = validateManifest(result.manifest);
    const plan = generatePlan(result.manifest.projectId, result.manifest.tenantId, contacts);

    expect(result.manifest).toMatchObject({
      projectId: 'lidacomzap-gestao-inteligente',
      tenantId: 't-pratomineiro',
      operationId: opaqueOperationId
    });
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].currentDocument).toEqual({ exists: false });
  });

  it('implements the existing ContactImporter boundary without data acquisition', () => {
    const importer = new LocalCsvContactImporter({
      inputKind: 'CSV',
      mapping,
      operationId: opaqueOperationId,
      now: fixedNow
    });
    const internalPreview = importer.preview('Name,Phone,Tags\nCliente Teste Alfa,+55 11 90000-0001,fixture');

    expect(importer.source).toBe('CSV');
    expect(internalPreview.report.found).toBe(1);
  });

  it('fails closed for XLSX until an approved dependency decision exists', () => {
    expect(() => runLocalContactImport('not an xlsx payload', {
      inputKind: 'XLSX',
      now: fixedNow
    })).toThrow('XLSX_NOT_ENABLED');
  });

  it('requires safe .local.json manifests and .report.json reports', () => {
    const externalOutputDir = fs.mkdtempSync(path.join(fs.realpathSync.native(path.dirname(process.cwd())), 'contact-import-output-'));
    const manifestPath = path.join(externalOutputDir, 'output.local.json');
    const reportPath = path.join(externalOutputDir, 'output.report.json');

    try {
      expect(resolveSafeManifestOutputPath(manifestPath)).toMatch(/output\.local\.json$/);
      expect(resolveSafeReportOutputPath(reportPath)).toMatch(/output\.report\.json$/);
    } finally {
      fs.rmSync(externalOutputDir, { recursive: true, force: true });
    }

    expect(() => resolveSafeManifestOutputPath('tools/contact-import/output.local.json'))
      .toThrow('UNSAFE_MANIFEST_OUTPUT');
    expect(() => resolveSafeReportOutputPath('tools/contact-import/output.report.json'))
      .toThrow('UNSAFE_REPORT_OUTPUT');
    expect(() => resolveSafeManifestOutputPath('tools/contact-import/contacts.json'))
      .toThrow('UNSAFE_MANIFEST_OUTPUT');
    expect(() => resolveSafeReportOutputPath('tools/contact-import/report.json'))
      .toThrow('UNSAFE_REPORT_OUTPUT');
  });

  it('keeps --apply blocked by the existing bootstrap guard', () => {
    expect(() => assertNoApplyFlag(['--apply']))
      .toThrow('Live bootstrap execution is not enabled in F1B-05A.');
  });

  it('contains no network primitives, live providers, or credentials in import implementation files', () => {
    const importFiles = [
      'tools/contact-import/csvParser.ts',
      'tools/contact-import/errors.ts',
      'tools/contact-import/mapper.ts',
      'tools/contact-import/output.ts',
      'tools/contact-import/pipeline.ts',
      'tools/contact-import/types.ts'
    ];
    const contents = importFiles.map((file) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));

    for (const content of contents) {
      expect(content).not.toMatch(/\bfetch\s*\(|\baxios\b|\bhttps?\.request\s*\(|\bchild_process\b|firebase\.|firestore\.|googleapis|oauth/i);
      expect(content).not.toMatch(/apiKey|accessToken|client_secret|private_key|bearer\s+token|password/i);
    }
  });

  it('ships only fully fictional CSV fixtures and mapping configuration', () => {
    const fixture = fs.readFileSync(path.resolve(process.cwd(), 'tools/contact-import/fixtures/contacts-fixture.csv'), 'utf8');
    const mappingFile = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'tools/contact-import/fixtures/csv-mapping.json'), 'utf8'));

    expect(fixture).toContain('Cliente Teste');
    expect(mappingFile).toEqual(mapping);
  });
});
