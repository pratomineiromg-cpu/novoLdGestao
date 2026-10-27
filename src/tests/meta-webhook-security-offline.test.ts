import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InjectedHmacDigestVerifier } from '../../services/channel-gateway/crypto';
import { evaluateProviderLiveReadiness } from '../../services/channel-gateway/operability';
import { MetaOfficialBatchWebhookDecoder } from '../../services/channel-gateway/providers/metaOfficialProtocol';
import { handleMetaWebhookRequest } from '../../services/channel-gateway/providers/metaWebhookHandler';
import { META_SECURITY_EVIDENCE, MetaWebhookAuthenticator } from '../../services/channel-gateway/providers/metaWebhookSecurity';
import { createLiveWebhookRequest, type CreateLiveWebhookRequestInput } from '../../services/channel-gateway/rawWebhook';
import { isSecretRef, UnconfiguredSecretResolver } from '../../services/channel-gateway/secrets';
import { executeMetaSecuritySimulator, loadSecuritySyntheticBody, signSyntheticBody,
  syntheticAppSecret, syntheticMetaDependencies, syntheticVerifyToken } from '../../services/channel-gateway/simulator/metaSecurity';

const now = new Date('2026-09-04T12:00:00.000Z');
const body = loadSecuritySyntheticBody('inbound');
function post(overrides: Partial<CreateLiveWebhookRequestInput> = {}) {
  return createLiveWebhookRequest({ method: 'POST', rawBody: body, receivedAt: now,
    requestId: 'untrusted-address-like-request-id',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signSyntheticBody(body) }, ...overrides });
}
function get(fields: Record<string, string | undefined> = {}) {
  const query = { 'hub.mode': 'subscribe', 'hub.verify_token': syntheticVerifyToken, 'hub.challenge': '001234', ...fields };
  return createLiveWebhookRequest({ method: 'GET', rawBody: new TextEncoder().encode('{invalid'),
    query: Object.fromEntries(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    receivedAt: now, requestId: 'untrusted-get-id' });
}
afterEach(() => vi.restoreAllMocks());

describe('F1B-09 archived Meta security protocol offline', () => {
  it('verifies synthetic HMAC on the existing timing-safe primitive path', () => {
    const primitive = vi.spyOn(InjectedHmacDigestVerifier.prototype, 'verify');
    const dependencies = syntheticMetaDependencies();
    const response = handleMetaWebhookRequest(post(), dependencies);
    expect(response.statusCode).toBe(200);
    expect(response.processingResult?.outcome).toBe('ACCEPTED');
    expect(primitive).toHaveBeenCalledOnce();
    expect(primitive.mock.calls[0][0].rawBody).toEqual(body);
    const source = fs.readFileSync('services/channel-gateway/crypto.ts', 'utf8');
    expect(source).toMatch(/expected.byteLength === input.presentedDigest.byteLength &&\s+timingSafeEqual\(expected, input.presentedDigest\)/);
    expect(source).toContain("createHmac(this.algorithm, this.secretBytes).update(input.rawBody)");
  });

  it('rejects a wrong resolved secret before decode', () => {
    const dependencies = syntheticMetaDependencies();
    dependencies.secretResolver = { resolve: () => ({ status: 'RESOLVED', bytes: new TextEncoder().encode('SYNTHETIC_WRONG_SECRET') }) };
    const decoder = vi.spyOn(MetaOfficialBatchWebhookDecoder.prototype, 'decodeBatch');
    expect(handleMetaWebhookRequest(post(), dependencies).audit.at(-1)?.reason).toBe('SIGNATURE_MISMATCH');
    expect(decoder).not.toHaveBeenCalled();
  });

  it('rejects changed raw bytes and JSON reserialization with the original signature', () => {
    const compact = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(body))));
    expect(compact).not.toEqual(body);
    for (const changed of [new Uint8Array([...body, 32]), compact]) {
      expect(handleMetaWebhookRequest(post({ rawBody: changed }), syntheticMetaDependencies())
        .audit.at(-1)?.reason).toBe('SIGNATURE_MISMATCH');
    }
  });

  it.each([
    ['missing', undefined, 'SIGNATURE_MISSING'],
    ['empty', '', 'SIGNATURE_MALFORMED'],
    ['prefix case', `SHA256=${'aa'.repeat(32)}`, 'SIGNATURE_MALFORMED'],
    ['algorithm', `sha1=${'aa'.repeat(32)}`, 'SIGNATURE_MALFORMED'],
    ['non hex', `sha256=${'gg'.repeat(32)}`, 'SIGNATURE_MALFORMED'],
    ['short', `sha256=${'aa'.repeat(31)}`, 'SIGNATURE_MALFORMED'],
    ['long', `sha256=${'aa'.repeat(33)}`, 'SIGNATURE_MALFORMED'],
    ['trailing newline', `${signSyntheticBody(body)}\n`, 'SIGNATURE_MALFORMED'],
    ['multiple', `${signSyntheticBody(body)},${signSyntheticBody(body)}`, 'SIGNATURE_MALFORMED'],
    ['mutated', `sha256=${'00'.repeat(32)}`, 'SIGNATURE_MISMATCH']
  ])('fails closed for %s signature without decoding or idempotency', (_name, signature, reason) => {
    const dependencies = syntheticMetaDependencies();
    const decode = vi.spyOn(MetaOfficialBatchWebhookDecoder.prototype, 'decodeBatch');
    const acquire = vi.spyOn(dependencies.idempotencyStore, 'tryAcquire');
    const resolve = vi.spyOn(dependencies.contactIdentityResolver, 'resolve');
    const response = handleMetaWebhookRequest(post({
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature }
    }), dependencies);
    expect(response.statusCode).toBe(403);
    expect(response.audit.at(-1)?.reason).toBe(reason);
    expect(decode).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('accepts mixed-case header names and hex, but rejects duplicate case aliases and arrays', () => {
    const signature = `sha256=${signSyntheticBody(body).slice(7).toUpperCase()}`;
    expect(handleMetaWebhookRequest(post({ headers: { 'CONTENT-TYPE': 'application/json',
      'X-Hub-Signature-256': signature } }), syntheticMetaDependencies()).statusCode).toBe(200);
    for (const headers of [
      { 'X-Hub-Signature-256': signature, 'x-hub-signature-256': signature },
      { 'X-Hub-Signature-256': [signature, signature] }
    ]) {
      expect(handleMetaWebhookRequest(post({ headers: { 'content-type': 'application/json', ...headers } }),
        syntheticMetaDependencies()).audit.at(-1)?.reason).toBe('SIGNATURE_MALFORMED');
    }
  });

  it('keeps missing, unconfigured, empty and failing secret resolution fail-closed', () => {
    const decode = vi.spyOn(MetaOfficialBatchWebhookDecoder.prototype, 'decodeBatch');
    for (const resolver of [undefined, new UnconfiguredSecretResolver(),
      { resolve: () => ({ status: 'RESOLVED' as const, bytes: new Uint8Array() }) },
      { resolve: () => { throw new Error('SYNTHETIC_SENSITIVE_ERROR'); } }]) {
      const dependencies = syntheticMetaDependencies();
      dependencies.secretResolver = resolver;
      const response = handleMetaWebhookRequest(post(), dependencies);
      expect(response.statusCode).toBe(503);
      expect(response.audit.at(-1)?.reason).toBe('APP_SECRET_NOT_CONFIGURED');
      expect(JSON.stringify(response)).not.toContain('SYNTHETIC_SENSITIVE_ERROR');
    }
    const dependencies = syntheticMetaDependencies();
    delete dependencies.config.appSecretRef;
    expect(handleMetaWebhookRequest(post(), dependencies).audit.at(-1)?.result).toBe('NOT_CONFIGURED');
    expect(decode).not.toHaveBeenCalled();
  });

  it('snapshots raw input so caller mutation during secret resolution cannot replace authenticated bytes', () => {
    const request = post();
    const dependencies = syntheticMetaDependencies();
    const resolver = dependencies.secretResolver!;
    dependencies.secretResolver = { resolve: (ref) => {
      request.rawBody.fill(32);
      return resolver.resolve(ref);
    } };
    expect(handleMetaWebhookRequest(request, dependencies).processingResult?.outcome).toBe('ACCEPTED');
    const original = new Uint8Array(body);
    const captured = post({ rawBody: original });
    original.fill(0);
    expect(captured.rawBody).toEqual(body);
  });

  it('returns only the verified challenge and never decodes GET body', () => {
    const decode = vi.spyOn(MetaOfficialBatchWebhookDecoder.prototype, 'decodeBatch');
    const dependencies = syntheticMetaDependencies();
    dependencies.config.maxWebhookBodyBytes = 1;
    const acquire = vi.spyOn(dependencies.idempotencyStore, 'tryAcquire');
    const response = handleMetaWebhookRequest(get(), dependencies);
    expect(response).toMatchObject({ statusCode: 200, body: '001234',
      headers: { 'content-type': 'text/plain; charset=utf-8' } });
    expect(response.audit.at(-1)?.reason).toBe('VERIFY_TOKEN_MATCH');
    expect(response.processingResult).toBeUndefined();
    expect(decode).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong token', { 'hub.verify_token': 'SYNTHETIC_WRONG_TOKEN' }],
    ['missing token', { 'hub.verify_token': undefined }],
    ['empty token', { 'hub.verify_token': '' }],
    ['oversized token', { 'hub.verify_token': 'a'.repeat(4097) }],
    ['wrong mode', { 'hub.mode': 'unsubscribe' }],
    ['missing challenge', { 'hub.challenge': undefined }],
    ['empty challenge', { 'hub.challenge': '' }],
    ['unsafe challenge', { 'hub.challenge': '123\n' }],
    ['oversized challenge', { 'hub.challenge': '1'.repeat(257) }]
  ])('rejects handshake %s without reflecting a challenge', (_name, fields) => {
    const response = handleMetaWebhookRequest(get(fields), syntheticMetaDependencies());
    expect(response.statusCode).toBe(403);
    expect(response.body).toBe('');
    expect(response.audit.at(-1)?.result).toBe('REJECTED');
  });

  it('rejects ambiguous repeated query values and keeps absent verify token config NOT_CONFIGURED', () => {
    const request = get();
    const ambiguous = { ...request, query: { ...request.query, 'hub.verify_token': [syntheticVerifyToken, syntheticVerifyToken] } };
    expect(handleMetaWebhookRequest(ambiguous as unknown as typeof request, syntheticMetaDependencies()).statusCode).toBe(403);
    const dependencies = syntheticMetaDependencies();
    delete dependencies.config.verifyTokenRef;
    expect(handleMetaWebhookRequest(get(), dependencies).audit.at(-1)?.reason).toBe('VERIFY_TOKEN_NOT_CONFIGURED');
  });

  it('serializes only opaque references and rejects embedded secret fields', () => {
    const dependencies = syntheticMetaDependencies();
    expect(isSecretRef({ id: 'secret-ref-opaque' })).toBe(true);
    expect(isSecretRef({ id: 'secret-ref-opaque', value: 'SYNTHETIC_SECRET' })).toBe(false);
    expect(isSecretRef({ id: 'secret-ref-opaque\n' })).toBe(false);
    expect(JSON.stringify(dependencies.secretResolver)).toBe('{}');
    const serialized = JSON.stringify(dependencies.config);
    expect(serialized).not.toContain(syntheticVerifyToken);
    expect(serialized).not.toContain(new TextDecoder().decode(syntheticAppSecret));
    Object.assign(dependencies.config, { appSecret: 'SYNTHETIC_FORBIDDEN_CONFIG_VALUE' });
    expect(handleMetaWebhookRequest(post(), dependencies).audit.at(-1)?.reason).toBe('SECURITY_POLICY_NOT_CONFIGURED');
  });

  it('executes signature then batch decode/admission; replay never performs pre-ACK identity resolution', () => {
    const order: string[] = [];
    const dependencies = syntheticMetaDependencies();
    const auth = MetaWebhookAuthenticator.prototype.verify;
    vi.spyOn(MetaWebhookAuthenticator.prototype, 'verify').mockImplementation(function (request) {
      order.push('auth'); return auth.call(this, request);
    });
    const decoder = MetaOfficialBatchWebhookDecoder.prototype.decodeBatch;
    vi.spyOn(MetaOfficialBatchWebhookDecoder.prototype, 'decodeBatch').mockImplementation(function (request, context) {
      order.push('decode'); return decoder.call(this, request, context);
    });
    const acquire = vi.spyOn(dependencies.idempotencyStore, 'tryAcquire');
    const identity = vi.spyOn(dependencies.contactIdentityResolver, 'resolve');
    const conversation = vi.spyOn(dependencies.conversationResolver, 'resolve');

    expect(handleMetaWebhookRequest(post(), dependencies).processingResult?.outcome).toBe('ACCEPTED');
    expect(order).toEqual(['auth', 'decode']);
    expect(acquire).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
    expect(conversation).not.toHaveBeenCalled();

    order.length = 0;
    const replay = handleMetaWebhookRequest(post(), dependencies);
    expect(replay.processingResult?.outcome).toBe('DUPLICATE');
    expect(replay.processingResult).not.toHaveProperty('command');
    expect(order).toEqual(['auth', 'decode']);
    expect(identity).not.toHaveBeenCalled();
    expect(conversation).not.toHaveBeenCalled();
    expect(replay.audit.at(-1)?.duplicate).toBe(true);
    expect(replay.statusCode).toBe(200);
  });

  it('keeps identity resolution outside the authenticated HTTP admission path', () => {
    const dependencies = syntheticMetaDependencies();
    const resolve = vi.spyOn(dependencies.contactIdentityResolver, 'resolve').mockImplementation(() => {
      throw new Error('SYNTHETIC_DOWNSTREAM_ONLY_FAILURE');
    });
    const response = handleMetaWebhookRequest(post(), dependencies);
    expect(response.statusCode).toBe(200);
    expect(response.ackDecision).toBe('ACKNOWLEDGE');
    expect(response.processingResult?.outcome).toBe('ACCEPTED');
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', '{invalid', 'MALFORMED_REQUEST'],
    ['invalid UTF8', new Uint8Array([0xff]), 'MALFORMED_REQUEST'],
    ['malformed envelope', '{}', 'INVALID_EVENT']
  ])('rejects signed %s only after authentication', (_name, raw, reason) => {
    const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
    const dependencies = syntheticMetaDependencies();
    const acquire = vi.spyOn(dependencies.idempotencyStore, 'tryAcquire');
    const decode = vi.spyOn(MetaOfficialBatchWebhookDecoder.prototype, 'decodeBatch');
    const response = handleMetaWebhookRequest(post({ rawBody: bytes,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signSyntheticBody(bytes) } }), dependencies);
    expect(response.statusCode).toBe(400);
    expect(response.audit[0]).toMatchObject({ event: 'META_WEBHOOK_SIGNATURE', result: 'VERIFIED' });
    expect(response.audit.at(-1)?.reason).toBe(reason);
    expect(decode).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
  });

  it('rejects unsupported methods before any secret, decoder, or store operation', () => {
    const dependencies = syntheticMetaDependencies();
    const resolve = vi.spyOn(dependencies.secretResolver!, 'resolve');
    const decode = vi.spyOn(MetaOfficialBatchWebhookDecoder.prototype, 'decodeBatch');
    for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'TRACE', 'UNTRUSTED_METHOD_CONTENT']) {
      const response = handleMetaWebhookRequest(post({ method }), dependencies);
      expect(response).toMatchObject({ statusCode: 405, headers: { allow: 'GET, POST' } });
      expect(response.audit.at(-1)).toMatchObject({ method: 'OTHER', reason: 'METHOD_NOT_ALLOWED' });
      expect(JSON.stringify(response.audit)).not.toContain(method);
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it('enforces byte-size boundary before content, auth or parse and accepts the exact maximum', () => {
    const dependencies = syntheticMetaDependencies();
    const resolve = vi.spyOn(dependencies.secretResolver!, 'resolve');
    const decode = vi.spyOn(MetaOfficialBatchWebhookDecoder.prototype, 'decodeBatch');
    dependencies.config.maxWebhookBodyBytes = body.byteLength - 1;
    expect(handleMetaWebhookRequest(post({ headers: {} }), dependencies).audit.at(-1)?.reason).toBe('PAYLOAD_TOO_LARGE');
    expect(resolve).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    dependencies.config.maxWebhookBodyBytes = body.byteLength;
    expect(handleMetaWebhookRequest(post(), dependencies).statusCode).toBe(200);
  });

  it('enforces JSON content type and normalizes the UTF-8 charset parameter', () => {
    for (const contentType of ['application/json', 'Application/JSON; Charset=UTF-8', 'application/json; charset="utf-8"']) {
      expect(handleMetaWebhookRequest(post({ headers: { 'content-type': contentType,
        'x-hub-signature-256': signSyntheticBody(body) } }), syntheticMetaDependencies()).statusCode).toBe(200);
    }
    const auth = vi.spyOn(MetaWebhookAuthenticator.prototype, 'verify');
    for (const contentType of [undefined, 'text/plain', 'application/json,application/json', 'application/json; charset=latin1']) {
      expect(handleMetaWebhookRequest(post({ headers: { 'content-type': contentType } }), syntheticMetaDependencies())
        .audit.at(-1)?.reason).toBe('UNSUPPORTED_CONTENT_TYPE');
    }
    expect(auth).not.toHaveBeenCalled();
  });

  it('does not accept an invalid size policy or synthetic trust marker on the HTTP path', () => {
    for (const size of [0, -1, NaN, Infinity, 0.5]) {
      const dependencies = syntheticMetaDependencies(); dependencies.config.maxWebhookBodyBytes = size;
      expect(handleMetaWebhookRequest(post(), dependencies).statusCode).toBe(503);
    }
    const request = post();
    expect(handleMetaWebhookRequest({ ...request, trustMode: 'TRUSTED_SYNTHETIC_FIXTURE' } as unknown as typeof request,
      syntheticMetaDependencies()).audit.at(-1)?.reason).toBe('INVALID_TRUST_MODE');
  });

  it('generates independent opaque IDs and limits audit to safe technical fields', () => {
    const dependencies = syntheticMetaDependencies();
    const first = handleMetaWebhookRequest(post(), dependencies);
    const second = handleMetaWebhookRequest(get(), dependencies);
    for (const response of [first, second]) {
      for (const audit of response.audit) {
        expect(Object.keys(audit).sort()).toEqual(['correlationId', 'duplicate', 'durationMs', 'event', 'method', 'provider',
          'reason', 'requestId', 'result', 'timestamp'].sort());
        expect(audit.requestId).toMatch(/^request-[0-9a-f-]{36}$/);
        expect(audit.correlationId).toMatch(/^correlation-[0-9a-f-]{36}$/);
      }
      const serialized = JSON.stringify(response.audit);
      for (const forbidden of [syntheticVerifyToken, new TextDecoder().decode(syntheticAppSecret),
        signSyntheticBody(body), 'untrusted-address-like-request-id', '+15555550123', 'wamid.synthetic',
        'Synthetic official envelope message', '001234']) expect(serialized).not.toContain(forbidden);
    }
    expect(first.audit[0].requestId).not.toBe(second.audit[0].requestId);
    expect(first.audit[0].correlationId).not.toBe(second.audit[0].correlationId);
  });

  it('keeps sent, delivered, read, failed and provider timestamps despite nonchronological arrival', () => {
    const dependencies = syntheticMetaDependencies();
    for (const kind of ['read', 'delivered', 'sent', 'failed'] as const) {
      const bytes = loadSecuritySyntheticBody(kind);
      const response = handleMetaWebhookRequest(post({ rawBody: bytes,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signSyntheticBody(bytes) } }), dependencies);
      expect(response.processingResult?.outcome).toBe('ACCEPTED');
      if (response.processingResult?.outcome !== 'ACCEPTED') throw new Error('EXPECTED_ACCEPTED');
      const status = JSON.parse(new TextDecoder().decode(bytes)).entry[0].changes[0].value.statuses[0];
      const event = response.processingResult.event;
      expect(event.payload.providerTimestamp).toBe(status.timestamp);
      expect(event.occurredAt.getTime()).toBe(Number(status.timestamp) * 1000);
      expect(event.payload.readStatus ?? event.payload.deliveryStatus).toBe(kind.toUpperCase());
    }
  });

  it('retains archived evidence and immutable live blockers even with optimistic flags', () => {
    expect(META_SECURITY_EVIDENCE).toMatchObject({ provenance: 'META_OFFICIAL_ARCHIVED',
      reconfirmation: 'PENDING_CURRENT_META_RECONFIRMATION', signature: 'OFFLINE_SIGNATURE_PROTOCOL_IMPLEMENTED',
      handshake: 'OFFLINE_HANDSHAKE_PROTOCOL_IMPLEMENTED' });
    const readiness = evaluateProviderLiveReadiness({ provider: 'WHATSAPP_META_OFFICIAL',
      officialProtocolVerified: true, officialSignatureProtocolVerified: true, officialHandshakeProtocolVerified: true,
      wabaSubscriptionConfigured: true, webhookVerifyTokenConfigured: true, httpsIngressConfigured: true,
      tlsCertificateConfigured: true, transportConfigured: true, durablePersistenceConfigured: true });
    expect(readiness.status).toBe('NOT_READY');
    expect(readiness.reasons).toContain('CURRENT_META_PROTOCOL_RECONFIRMATION_REQUIRED');
    expect(readiness.reasons).toContain('PRODUCTION_DURABLE_STORE_NOT_CONFIGURED');
  });

  it('runs every security simulation without exposing payload or secrets', () => {
    const lines: string[] = [];
    expect(executeMetaSecuritySimulator((line) => lines.push(line))).toBe(0);
    expect(lines).toHaveLength(8);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ mode: 'Simulação', pass: true });
    expect(lines.join('\n')).not.toContain(syntheticVerifyToken);
    expect(lines.join('\n')).not.toContain(signSyntheticBody(body));
    expect(lines.join('\n')).not.toContain(new TextDecoder().decode(syntheticAppSecret));
  });

  it('preserves domain direction and contains no gateway network or persistence integration', () => {
    const readSources = (root: string): string => fs.readdirSync(root, { withFileTypes: true }).map((entry) => {
      const file = path.join(root, entry.name);
      if (entry.isDirectory() && entry.name === 'adapters') return '';
      return entry.isDirectory() ? readSources(file) : entry.name.endsWith('.ts') ? fs.readFileSync(file, 'utf8') : '';
    }).join('\n');
    const domain = readSources('src/domain');
    expect(domain).not.toMatch(/(?:from|import\s*\()\s*['"][^'"]*(?:channel-gateway|node:http|metaWebhook)/i);
    const gateway = readSources('services/channel-gateway');
    expect(gateway).not.toMatch(/\bfetch\s*\(|\baxios\b|https?\.request|net\.connect|tls\.connect|WebSocket|graph\.facebook|\.listen\s*\(/);
    expect(gateway).not.toMatch(/(?:from|import\s*\()\s*['"][^'"]*(?:firebase|firestore|@google-cloud\/firestore|node:http|node:https|node:net|node:tls)/i);
  });
});
