import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

describe('GitHub to AI Studio synchronization experiment', () => {
  it('makes the test tab accessible through the authorized app layout', () => {
    expect(source('src/App.tsx')).toContain("import { TesteGithub } from './views/TesteGithub';");
    expect(source('src/App.tsx')).toContain('<Route path="teste-github" element={<TesteGithub />} />');
    expect(source('src/components/Sidebar.tsx')).toContain(
      "{ name: 'Teste GitHub', path: '/teste-github', icon: FlaskConical },"
    );
  });

  it('renders a unique identifier without changing production data', () => {
    const view = source('src/views/TesteGithub.tsx');
    expect(view).toContain('TESTE-GITHUB-AISTUDIO-2026-10-27');
    expect(view).toContain('data-testid="github-ai-studio-sync-marker"');
    expect(view).not.toMatch(/(localStorage|fetch\(|saveData\(|Firestore|firebase)/);
  });
});
