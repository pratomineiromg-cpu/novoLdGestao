import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeBootstrapPlanOffline, resolveSafePlanOutputPath } from '../../tools/contact-bootstrap/cli';
import { executeLocalContactImportCli } from '../../tools/contact-import/cli';
import { resolveSafeManifestOutputPath, resolveSafeReportOutputPath } from '../../tools/contact-import/output';
import { auditWorkspacePrivacy, formatWorkspacePrivacyAudit } from '../../tools/privacy/workspacePrivacyCheck';

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), `lcz-${prefix}-`));
  tempRoots.push(created);
  return created;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('F1B-07A workspace privacy hardening', () => {
  it('audits names and paths without reading file content', () => {
    const root = makeTempDir('privacy-clean');
    fs.mkdirSync(path.join(root, 'safe'), { recursive: true });
    fs.writeFileSync(path.join(root, 'safe', 'notes.txt'), 'synthetic notes only');

    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      const audit = auditWorkspacePrivacy(root);

      expect(audit.ok).toBe(true);
      expect(formatWorkspacePrivacyAudit(audit)).toContain('PASS');
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });

  it('detects private local JSON files inside a repository tree by filename', () => {
    const root = makeTempDir('privacy-local');
    fs.writeFileSync(path.join(root, 'customer.local.json'), '{"synthetic":true}');

    const audit = auditWorkspacePrivacy(root);

    expect(audit.ok).toBe(false);
    expect(audit.issues).toEqual([
      { code: 'PRIVATE_WORKSPACE_FILE', relativePath: 'customer.local.json' }
    ]);
  });

  it('detects generated plan and report artifacts inside a repository tree by filename', () => {
    const root = makeTempDir('privacy-artifacts');
    fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tools', 'candidate.plan.json'), '{"synthetic":true}');
    fs.writeFileSync(path.join(root, 'tools', 'candidate.report.json'), '{"synthetic":true}');

    const audit = auditWorkspacePrivacy(root);

    expect(audit.ok).toBe(false);
    expect(audit.issues.map((issue) => issue.relativePath).sort()).toEqual([
      'tools/candidate.plan.json',
      'tools/candidate.report.json'
    ]);
  });

  it('passes when private data lives outside the scanned repository tree', () => {
    const root = makeTempDir('privacy-repo');
    const privateRoot = makeTempDir('privacy-external');
    fs.writeFileSync(path.join(privateRoot, 'customer.local.json'), '{"synthetic":true}');

    const audit = auditWorkspacePrivacy(root);

    expect(audit.ok).toBe(true);
    expect(audit.issues).toEqual([]);
  });

  it('does not follow suspicious symlinks when the host permits creating them', () => {
    const root = makeTempDir('privacy-link-repo');
    const privateRoot = makeTempDir('privacy-link-external');
    const target = path.join(privateRoot, 'customer.local.json');
    const link = path.join(root, 'customer.local.json');
    fs.writeFileSync(target, '{"synthetic":true}');

    try {
      fs.symlinkSync(target, link);
    } catch {
      return;
    }

    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      const audit = auditWorkspacePrivacy(root);

      expect(audit.ok).toBe(false);
      expect(audit.issues).toEqual([
        { code: 'SUSPICIOUS_SYMLINK', relativePath: 'customer.local.json' }
      ]);
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });

  it('allows contact tooling to use absolute external input and output paths', () => {
    const externalRoot = makeTempDir('privacy-tooling');
    const manifestOutput = path.join(externalRoot, 'contact-import.local.json');
    const reportOutput = path.join(externalRoot, 'contact-import.report.json');
    const planOutput = path.join(externalRoot, 'contact-bootstrap.plan.json');
    const inputPath = path.join(externalRoot, 'contacts.csv');
    const mappingPath = path.resolve(process.cwd(), 'tools/contact-import/fixtures/csv-mapping.json');

    fs.writeFileSync(inputPath, 'Name,Phone,Tags\nCliente Teste,+55 11 90000-0001,fixture');

    const result = executeLocalContactImportCli([
      '--mode', 'manifest',
      '--input', inputPath,
      '--source', 'CSV',
      '--mapping-file', mappingPath,
      '--output', manifestOutput,
      '--report', reportOutput
    ]);

    expect(result.manifestWritten).toBe(true);
    expect(result.reportWritten).toBe(true);
    expect(resolveSafeManifestOutputPath(manifestOutput)).toBe(manifestOutput);
    expect(resolveSafeReportOutputPath(reportOutput)).toBe(reportOutput);
    expect(resolveSafePlanOutputPath(planOutput)).toBe(planOutput);

    const manifest = JSON.parse(fs.readFileSync(manifestOutput, 'utf8'));
    executeBootstrapPlanOffline(manifest, planOutput);
    expect(fs.existsSync(planOutput)).toBe(true);
  });

  it('blocks contact output paths inside the repository tree', () => {
    expect(() => resolveSafeManifestOutputPath(path.resolve(process.cwd(), 'blocked.local.json')))
      .toThrow('UNSAFE_MANIFEST_OUTPUT');
    expect(() => resolveSafeReportOutputPath(path.resolve(process.cwd(), 'blocked.report.json')))
      .toThrow('UNSAFE_REPORT_OUTPUT');
    expect(() => resolveSafePlanOutputPath(path.resolve(process.cwd(), 'blocked.plan.json')))
      .toThrow('Private customer data outputs must be written outside the repository.');
  });

  it('keeps the current workspace free of private local data files and generated artifacts', () => {
    const audit = auditWorkspacePrivacy(process.cwd());

    expect(audit.ok).toBe(true);
    expect(audit.issues).toEqual([]);
  });
});
