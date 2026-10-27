import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContactImportError } from './errors';
import { writeLocalManifest, writeSanitizedReport } from './output';
import { runLocalContactImport } from './pipeline';
import { ExplicitColumnMapping, LocalContactImportInputKind } from './types';

type CliMode = 'preview' | 'manifest';

interface CliOptions {
  mode?: CliMode;
  inputPath?: string;
  inputKind?: LocalContactImportInputKind;
  mappingFile?: string;
  outputPath?: string;
  reportPath?: string;
}

function parseInputKind(value: string | undefined): LocalContactImportInputKind {
  if (value === 'CSV' || value === 'GOOGLE_CONTACTS_CSV_EXPORT' || value === 'XLSX') {
    return value;
  }
  throw new ContactImportError('UNSUPPORTED_INPUT');
}

function parseMode(value: string | undefined): CliMode {
  if (value === 'preview' || value === 'manifest') {
    return value;
  }
  throw new ContactImportError('UNSUPPORTED_ARGUMENT');
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes('--apply')) {
    throw new ContactImportError('UNSUPPORTED_ARGUMENT');
  }

  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--mode') {
      options.mode = parseMode(value);
    } else if (arg === '--input') {
      options.inputPath = value;
    } else if (arg === '--source') {
      options.inputKind = parseInputKind(value);
    } else if (arg === '--mapping-file') {
      options.mappingFile = value;
    } else if (arg === '--output') {
      options.outputPath = value;
    } else if (arg === '--report') {
      options.reportPath = value;
    } else if (arg.startsWith('--')) {
      throw new ContactImportError('UNSUPPORTED_ARGUMENT');
    } else {
      continue;
    }
    index += 1;
  }
  return options;
}

function readExplicitMapping(mappingFile: string | undefined): ExplicitColumnMapping | undefined {
  if (!mappingFile) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), mappingFile), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.name !== 'string' || typeof parsed.phone !== 'string') {
      throw new ContactImportError('MAPPING_INVALID');
    }
    if (parsed.email !== undefined && typeof parsed.email !== 'string') {
      throw new ContactImportError('MAPPING_INVALID');
    }
    if (parsed.tags !== undefined && typeof parsed.tags !== 'string') {
      throw new ContactImportError('MAPPING_INVALID');
    }
    return {
      name: parsed.name,
      phone: parsed.phone,
      email: parsed.email,
      tags: parsed.tags
    };
  } catch (error) {
    if (error instanceof ContactImportError) throw error;
    throw new ContactImportError('MAPPING_INVALID');
  }
}

function readInput(inputPath: string | undefined): string {
  if (!inputPath) {
    throw new ContactImportError('INPUT_REQUIRED');
  }
  try {
    return fs.readFileSync(path.resolve(process.cwd(), inputPath), 'utf8');
  } catch {
    throw new ContactImportError('INPUT_REQUIRED');
  }
}

export function executeLocalContactImportCli(argv: string[]): Record<string, unknown> {
  const options = parseArgs(argv);
  const mode = options.mode ?? parseMode(undefined);
  const inputKind = options.inputKind ?? parseInputKind(undefined);
  const result = runLocalContactImport(readInput(options.inputPath), {
    inputKind,
    mapping: readExplicitMapping(options.mappingFile)
  });

  let reportWritten = false;
  let manifestWritten = false;
  if (options.reportPath) {
    writeSanitizedReport(options.reportPath, result.sanitizedPreview);
    reportWritten = true;
  }
  if (mode === 'manifest') {
    if (!options.outputPath) {
      throw new ContactImportError('UNSAFE_MANIFEST_OUTPUT');
    }
    writeLocalManifest(options.outputPath, result.manifest);
    manifestWritten = true;
  }

  return {
    ...result.sanitizedPreview,
    reportWritten,
    manifestWritten
  };
}

export function runCli(argv: string[] = process.argv.slice(2)): void {
  try {
    const result = executeLocalContactImportCli(argv);
    console.log(JSON.stringify(result));
  } catch (error) {
    const code = error instanceof ContactImportError ? error.code : 'UNSUPPORTED_ARGUMENT';
    console.error(`FAIL ${code}`);
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('cli.ts')
);

if (isMainModule) {
  runCli();
}
