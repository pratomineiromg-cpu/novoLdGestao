import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepositoryRoot } from './privateDataPaths';

const PRIVATE_FILE_SUFFIXES = ['.local.json', '.plan.json', '.report.json'] as const;
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);

export type WorkspacePrivacyIssueCode =
  | 'PRIVATE_WORKSPACE_FILE'
  | 'SUSPICIOUS_SYMLINK';

export interface WorkspacePrivacyIssue {
  code: WorkspacePrivacyIssueCode;
  relativePath: string;
}

export interface WorkspacePrivacyAudit {
  ok: boolean;
  root: string;
  issues: WorkspacePrivacyIssue[];
}

function toRelativePath(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join('/');
}

function hasPrivateSuffix(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return PRIVATE_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function hasSuspiciousSymlinkName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return hasPrivateSuffix(fileName) || lower.includes('private-data') || lower.includes('localappdata');
}

export function auditWorkspacePrivacy(root = findRepositoryRoot()): WorkspacePrivacyAudit {
  const resolvedRoot = path.resolve(root);
  const issues: WorkspacePrivacyIssue[] = [];

  function walk(directory: string): void {
    const entries = fs.readdirSync(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = toRelativePath(resolvedRoot, fullPath);

      if (entry.isSymbolicLink()) {
        if (hasSuspiciousSymlinkName(entry.name)) {
          issues.push({ code: 'SUSPICIOUS_SYMLINK', relativePath });
        }
        continue;
      }

      if (hasPrivateSuffix(entry.name)) {
        issues.push({ code: 'PRIVATE_WORKSPACE_FILE', relativePath });
      }

      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
        walk(fullPath);
      }
    }
  }

  walk(resolvedRoot);
  return {
    ok: issues.length === 0,
    root: resolvedRoot,
    issues
  };
}

export function formatWorkspacePrivacyAudit(audit: WorkspacePrivacyAudit): string {
  if (audit.ok) {
    return [
      'PASS',
      '0 private local data files inside repository.'
    ].join('\n');
  }

  return [
    'FAIL',
    `${audit.issues.length} private local data file(s) or generated artifact(s) inside repository.`,
    ...audit.issues.map((issue) => `${issue.code}: ${issue.relativePath}`)
  ].join('\n');
}

export function runCli(argv: string[] = process.argv.slice(2)): void {
  const rootArg = argv[0];
  const audit = auditWorkspacePrivacy(rootArg ? path.resolve(process.cwd(), rootArg) : findRepositoryRoot());
  const report = formatWorkspacePrivacyAudit(audit);
  console.log(report);
  if (!audit.ok) {
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('workspacePrivacyCheck.ts')
);

if (isMainModule) {
  runCli();
}
