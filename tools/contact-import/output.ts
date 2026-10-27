import * as fs from 'node:fs';
import * as path from 'node:path';
import { ContactImportError } from './errors';
import { SanitizedImportPreview } from './types';
import { BootstrapManifest } from '../contact-bootstrap/types';
import { assertPathOutsideRepository, findRepositoryRoot } from '../privacy/privateDataPaths';

function resolveOutputPath(outputPath: string, suffix: string, errorCode: 'UNSAFE_MANIFEST_OUTPUT' | 'UNSAFE_REPORT_OUTPUT'): string {
  if (!outputPath || !outputPath.toLowerCase().endsWith(suffix)) {
    throw new ContactImportError(errorCode);
  }
  const resolvedOutput = path.resolve(process.cwd(), outputPath);
  try {
    assertPathOutsideRepository(resolvedOutput, findRepositoryRoot());
  } catch {
    throw new ContactImportError(errorCode);
  }
  return resolvedOutput;
}

export function resolveSafeManifestOutputPath(outputPath: string): string {
  return resolveOutputPath(outputPath, '.local.json', 'UNSAFE_MANIFEST_OUTPUT');
}

export function resolveSafeReportOutputPath(outputPath: string): string {
  return resolveOutputPath(outputPath, '.report.json', 'UNSAFE_REPORT_OUTPUT');
}

export function writeSanitizedReport(outputPath: string, preview: SanitizedImportPreview): string {
  const resolved = resolveSafeReportOutputPath(outputPath);
  fs.writeFileSync(resolved, JSON.stringify(preview, null, 2), 'utf8');
  return resolved;
}

export function writeLocalManifest(outputPath: string, manifest: BootstrapManifest): string {
  const resolved = resolveSafeManifestOutputPath(outputPath);
  fs.writeFileSync(resolved, JSON.stringify(manifest, null, 2), 'utf8');
  return resolved;
}
