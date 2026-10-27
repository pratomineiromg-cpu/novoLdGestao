import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { validateManifest } from './validator';
import { generatePlan } from './planner';
import { BootstrapManifest, PlanFile } from './types';
import { assertPathOutsideRepository, findRepositoryRoot } from '../privacy/privateDataPaths';

export function assertNoApplyFlag(args: string[]): void {
  if (args.includes('--apply')) {
    throw new Error('Live bootstrap execution is not enabled in F1B-05A.');
  }
}

export function resolveSafePlanOutputPath(outputPath: string): string {
  if (!outputPath || !outputPath.toLowerCase().endsWith('.plan.json')) {
    throw new Error('Bootstrap plan output must use the ignored .plan.json suffix.');
  }
  const resolvedOutput = path.resolve(process.cwd(), outputPath);
  assertPathOutsideRepository(resolvedOutput, findRepositoryRoot());
  return resolvedOutput;
}

export function executeBootstrapPlanOffline(manifest: BootstrapManifest, outputPath?: string): PlanFile {
  const validatedContacts = validateManifest(manifest);
  const plan = generatePlan(manifest.projectId, manifest.tenantId, validatedContacts);
  
  if (outputPath) {
    const resolvedOutput = resolveSafePlanOutputPath(outputPath);
    fs.writeFileSync(resolvedOutput, JSON.stringify(plan, null, 2), 'utf-8');
  }
  
  return plan;
}

export function runCli(argv: string[] = process.argv.slice(2)): void {
  try {
    assertNoApplyFlag(argv);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  let inputPath = '';
  let outputPath = '';
  
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && argv[i + 1]) {
      inputPath = argv[i + 1];
      i++;
    } else if (argv[i] === '--output' && argv[i + 1]) {
      outputPath = argv[i + 1];
      i++;
    }
  }

  if (!inputPath) {
    console.error('Usage: tsx tools/contact-bootstrap/cli.ts --input <external-manifest.local.json> [--output <external-plan.plan.json>]');
    process.exit(1);
  }

  const resolvedInput = path.resolve(process.cwd(), inputPath);
  if (!fs.existsSync(resolvedInput)) {
    console.error(`Input file not found: ${resolvedInput}`);
    process.exit(1);
  }

  let manifest: BootstrapManifest;
  try {
    const content = fs.readFileSync(resolvedInput, 'utf-8');
    manifest = JSON.parse(content);
  } catch (e: any) {
    console.error(`Failed to read/parse input file: ${e.message}`);
    process.exit(1);
  }

  console.log(`Parsing and validating manifest for operation ID: ${manifest.operationId}...`);

  let plan: PlanFile;
  try {
    plan = executeBootstrapPlanOffline(manifest, outputPath);
  } catch (e: any) {
    console.error(`Validation Error: ${e.message}`);
    process.exit(1);
  }

  console.log(`Validation successful for ${plan.writes.length} contacts.`);
  if (outputPath) {
    const resolvedOutput = resolveSafePlanOutputPath(outputPath);
    console.log(`Plan written to: ${resolvedOutput}`);
  } else {
    console.log('No output path specified. Plan generated successfully in memory.');
  }

  console.log(`Summary:
Operation ID: ${manifest.operationId}
Project: ${manifest.projectId}
Tenant: ${manifest.tenantId}
Contacts to insert: ${plan.writes.length}
Writes planned: ${plan.writes.length}`);
}

const isMainModule = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('cli.ts')
);

if (isMainModule) {
  runCli();
}
