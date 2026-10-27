import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Architectural Integrity Tests', () => {
  it('Test 18 - Should not import MockRepository directly in core business logic', () => {
    const actionsContent = fs.readFileSync(path.join(__dirname, '../services/Actions.ts'), 'utf-8');
    const eventEngineContent = fs.readFileSync(path.join(__dirname, '../events/EventEngine.ts'), 'utf-8');

    // Strict regex against importing the concrete implementation
    expect(actionsContent).not.toMatch(/MockDatabase/);
    expect(actionsContent).not.toMatch(/MockRepository/);
    expect(eventEngineContent).not.toMatch(/MockDatabase/);
    expect(eventEngineContent).not.toMatch(/MockRepository/);
    
    // Strict regex against the forbidden generic update pattern
    expect(actionsContent).not.toMatch(/\.update\s*\(/);
    expect(eventEngineContent).not.toMatch(/\.update\s*\(/);
  });

  it('keeps runtime event logs free from message and order payloads', () => {
    const eventEngineContent = fs.readFileSync(path.join(__dirname, '../events/EventEngine.ts'), 'utf-8');

    expect(eventEngineContent).toContain("console.log('[EventEngine]', event.type);");
    expect(eventEngineContent).not.toMatch(/console\.log\([^)]*,\s*event\s*\)/);
  });

  it('keeps F1B-07 dependency directions offline and provider-neutral', () => {
    const readTree = (directory: string): string => fs.readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory() && entry.name === 'adapters') return [];
        return entry.isDirectory()
          ? [readTree(fullPath)]
          : entry.name.endsWith('.ts') ? [fs.readFileSync(fullPath, 'utf8')] : [];
      })
      .join('\n');
    const domain = readTree(path.resolve(process.cwd(), 'src/domain'));
    const gateway = readTree(path.resolve(process.cwd(), 'services/channel-gateway'));
    const providers = readTree(path.resolve(process.cwd(), 'services/channel-gateway/providers'));
    const routing = fs.readFileSync(path.resolve(process.cwd(), 'src/domain/routing.ts'), 'utf8');
    const contactTools = [
      readTree(path.resolve(process.cwd(), 'tools/contact-bootstrap')),
      readTree(path.resolve(process.cwd(), 'tools/contact-import'))
    ].join('\n');

    expect(domain).not.toMatch(/channel-gateway|firebase|firestore/i);
    expect(gateway).not.toMatch(/src[\\/]repositories|firebase|firestore|@google-cloud[\\/]firestore|src[\\/](components|views)/i);
    expect(providers).not.toMatch(/src[\\/](components|views)|react/i);
    expect(routing).not.toMatch(/ProviderTransport|channel-gateway/);
    expect(contactTools).not.toMatch(/channel-gateway|ProviderTransport/);
  });
});
