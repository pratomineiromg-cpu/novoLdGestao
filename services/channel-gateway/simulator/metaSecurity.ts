import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryDurableIdempotencyStore } from '../idempotency';
import { handleMetaWebhookRequest, type MetaWebhookRuntimeDependencies } from '../providers/metaWebhookHandler';
import { createLiveWebhookRequest } from '../rawWebhook';
import { InMemorySyntheticSecretResolver } from '../secrets';

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const syntheticAppSecret = new TextEncoder().encode('SYNTHETIC_ONLY_F1B09_APP_SECRET_NOT_A_CREDENTIAL');
export const syntheticVerifyToken = 'SYNTHETIC_ONLY_F1B09_VERIFY_TOKEN_NOT_A_CREDENTIAL';

export function syntheticMetaDependencies(): MetaWebhookRuntimeDependencies {
  const appSecretRef = { id: 'secret-ref-synthetic-app-001' };
  const verifyTokenRef = { id: 'secret-ref-synthetic-verify-001' };
  return {
    config: { appSecretRef, verifyTokenRef, maxWebhookBodyBytes: 16_384 },
    secretResolver: new InMemorySyntheticSecretResolver([
      { ref: appSecretRef, syntheticValue: syntheticAppSecret },
      { ref: verifyTokenRef, syntheticValue: new TextEncoder().encode(syntheticVerifyToken) }
    ]),
    idempotencyStore: new InMemoryDurableIdempotencyStore(),
    contactIdentityResolver: { resolve: () => ({ status: 'RESOLVED_EXISTING',
      contactId: 'synthetic-contact-opaque', contactIdentityId: 'synthetic-identity-opaque' }) },
    conversationResolver: { resolve: () => ({ status: 'RESOLVED_EXISTING',
      conversationId: 'synthetic-conversation-opaque' }) },
    leaseDurationMs: 30_000,
    clock: () => Date.parse('2026-09-04T12:00:00.000Z')
  };
}

export function signSyntheticBody(rawBody: Uint8Array): string {
  return `sha256=${createHmac('sha256', syntheticAppSecret).update(rawBody).digest('hex')}`;
}

export function loadSecuritySyntheticBody(kind: 'inbound' | 'sent' | 'delivered' | 'read' | 'failed'): Uint8Array {
  const filename = kind === 'inbound' ? 'meta-official-inbound-envelope.synthetic.json'
    : `meta-official-status-${kind}.synthetic.json`;
  return new Uint8Array(fs.readFileSync(path.join(fixtureRoot, filename)));
}

/** Each scenario asserts its expected outcome; output contains sanitized audit only. */
export function executeMetaSecuritySimulator(write: (line: string) => void = console.log): number {
  const body = loadSecuritySyntheticBody('inbound');
  const makeRequest = (rawBody = body, signature = signSyntheticBody(rawBody)) => createLiveWebhookRequest({
    method: 'POST', rawBody, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
    requestId: 'synthetic-ignored-input-id', receivedAt: new Date('2026-09-04T12:00:00.000Z')
  });
  const getRequest = (token: string) => createLiveWebhookRequest({
    method: 'GET', rawBody: new Uint8Array(), requestId: 'synthetic-ignored-get-id',
    receivedAt: new Date('2026-09-04T12:00:00.000Z'),
    query: { 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '123456' }
  });
  const replayDependencies = syntheticMetaDependencies();
  const cases = [
    { name: 'VALID_GET_HANDSHAKE', request: getRequest(syntheticVerifyToken), expected: 'VERIFIED' },
    { name: 'INVALID_VERIFY_TOKEN', request: getRequest('SYNTHETIC_WRONG_TOKEN'), expected: 'REJECTED' },
    { name: 'VALID_SIGNED_POST', request: makeRequest(), expected: 'ACCEPTED' },
    { name: 'WRONG_SIGNATURE', request: makeRequest(body, `sha256=${'00'.repeat(32)}`), expected: 'REJECTED' },
    { name: 'MODIFIED_BODY', request: makeRequest(new Uint8Array([...body, 32]), signSyntheticBody(body)), expected: 'REJECTED' },
    { name: 'VALID_SIGNED_OFFICIAL_INBOUND', request: makeRequest(), expected: 'ACCEPTED', dependencies: replayDependencies },
    { name: 'VALID_SIGNED_OFFICIAL_STATUS', request: makeRequest(loadSecuritySyntheticBody('read')), expected: 'ACCEPTED' },
    { name: 'AUTHENTICATED_DUPLICATE_REPLAY', request: makeRequest(), expected: 'DUPLICATE', dependencies: replayDependencies }
  ];
  let passed = true;
  for (const scenario of cases) {
    const response = handleMetaWebhookRequest(scenario.request, scenario.dependencies ?? syntheticMetaDependencies());
    const audit = response.audit.at(-1)!;
    const pass = audit.result === scenario.expected;
    passed &&= pass;
    write(JSON.stringify({ mode: 'Simulação', scenario: scenario.name, pass, statusCode: response.statusCode, audit }));
  }
  return passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = executeMetaSecuritySimulator();
}
