import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_PRIVATE_DATA_PARTS = ['LidacomZap', 'private-data'];

function withTrailingSeparator(value: string): string {
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

export function isPathInsideOrEqual(parentPath: string, candidatePath: string): boolean {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  if (process.platform === 'win32') {
    const parentLower = parent.toLowerCase();
    const candidateLower = candidate.toLowerCase();
    return candidateLower === parentLower || candidateLower.startsWith(withTrailingSeparator(parentLower));
  }
  return candidate === parent || candidate.startsWith(withTrailingSeparator(parent));
}

export function findRepositoryRoot(startDir = process.cwd()): string {
  let current = path.resolve(startDir);

  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }
    current = parent;
  }
}

export function resolvePrivateDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.LOCALAPPDATA ?? env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  return path.join(base, ...APP_PRIVATE_DATA_PARTS);
}

export function resolveContactBootstrapPrivateDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePrivateDataRoot(env), 'contact-bootstrap');
}

export function assertPathOutsideRepository(resolvedPath: string, repositoryRoot = findRepositoryRoot()): void {
  if (isPathInsideOrEqual(repositoryRoot, resolvedPath)) {
    throw new Error('Private customer data outputs must be written outside the repository.');
  }
}
