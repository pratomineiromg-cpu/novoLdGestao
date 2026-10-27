import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NormalizedChannelEvent, PreparedOutboundMessage } from '../../services/channel-gateway/contracts';
import { InjectedHmacDigestVerifier } from '../../services/channel-gateway/crypto';
import { classifyGatewayFailure } from '../../services/channel-gateway/errors';
import {
  InMemoryDurableIdempotencyStore
} from '../../services/channel-gateway/idempotency';
import {
  processLiveWebhookRequest,
  processTrustedSyntheticFixture
} from '../../services/channel-gateway/inbound';
import {
  ProviderHintRateLimitPolicy,
  UnconfiguredProviderTransport,
  createGatewayMetricEvent,
  durationBucket,
  evaluateProviderLiveReadiness,
  META_OFFLINE_LIVE_BLOCKERS,
  type ProviderSecretRefs
} from '../../services/channel-gateway/operability';
import { InMemoryOutboundQueue } from '../../services/channel-gateway/outboundQueue';
import { decodeMetaSyntheticFixture } from '../../services/channel-gateway/providers/metaSyntheticFixture';
import { RcsGoogleOfflineAdapter } from '../../services/channel-gateway/providers/rcs-google';
import {
  WhatsAppMetaLiveDecoderPending,
  WhatsAppMetaOfflineAdapter
} from '../../services/channel-gateway/providers/whatsapp-meta';
import {
  createLiveWebhookRequest,
  decodeRawWebhookJson,
  type ProviderRawDecoder,
  type RawWebhookRequest
} from '../../services/channel-gateway/rawWebhook';
import {
  mayContinueAfterConversationResolution,
  mayContinueAfterIdentityResolution
} from '../../services/channel-gateway/resolution';
import { calculateRetryDecision } from '../../services/channel-gateway/retryPolicy';
import {
  executeGatewaySimulatorCli,
  loadSyntheticFixture
} from '../../services/channel-gateway/simulator/cli';
import {
  transitionInboundState,
  transitionOutboundState
} from '../../services/channel-gateway/stateMachines';
import {
  UnconfiguredWebhookAuthenticator,
  type WebhookAuthenticationResult,
  type WebhookAuthenticator
} from '../../services/channel-gateway/webhookAuth';
import { UnconfiguredWebhookHandshakeVerifier } from '../../services/channel-gateway/handshake';

const now = new Date('2026-09-04T12:00:00.000Z');

function metaFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    synthetic: true,
    fixtureContract: 'INTERNAL_SYNTHETIC_META_V1',
    provider: 'WHATSAPP_META_OFFICIAL',
    channel: 'WHATSAPP',
    kind: 'inbound_message',
    providerEventId: 'synthetic-event-opaque-001',
    providerMessageId: 'synthetic-message-opaque-001',
    occurredAt: '2026-09-04T11:59:00.000Z',
    providerAddress: '+5511900000901',
    externalConversationId: 'synthetic-conversation-opaque-001',
    contentType: 'TEXT',
    text: 'Conteudo exclusivamente sintetico',
    ...overrides
  };
}

function liveRequest(body = '{"event":"opaque"}'): RawWebhookRequest {
  return createLiveWebhookRequest({
    method: 'post',
    path: '/opaque',
    rawBody: new TextEncoder().encode(body),
    headers: { 'X-TEST': 'technical' },
    query: { mode: 'technical' },
    receivedAt: now,
    requestId: 'request-opaque-001'
  });
}

class FixedAuthenticator implements WebhookAuthenticator {
  readonly provider = 'WHATSAPP_META_OFFICIAL' as const;
  readonly status = 'CONFIGURED' as const;

  constructor(private readonly result: 'VERIFIED' | 'REJECTED') {}

  verify(request: RawWebhookRequest): WebhookAuthenticationResult {
    return {
      status: this.result,
      reasonCode: `TEST_${this.result}`,
      provider: this.provider,
      requestId: request.requestId,
      evaluatedAt: now
    };
  }
}

class TestLiveDecoder implements ProviderRawDecoder {
  readonly provider = 'WHATSAPP_META_OFFICIAL' as const;
  calls = 0;

  decode(_request: RawWebhookRequest, context: { createInternalEventId: () => string }): NormalizedChannelEvent {
    this.calls += 1;
    return {
      internalEventId: context.createInternalEventId(),
      provider: this.provider,
      channel: 'WHATSAPP',
      providerEventId: 'live-test-event-opaque',
      occurredAt: now,
      eventType: 'INBOUND_MESSAGE',
      payload: { providerAddress: '+5511900000999', content: { contentType: 'TEXT', text: 'synthetic' } }
    };
  }
}

function liveOptions(authenticator: WebhookAuthenticator, liveDecoder: ProviderRawDecoder) {
  return {
    adapter: new WhatsAppMetaOfflineAdapter(),
    request: liveRequest(),
    authenticator,
    liveDecoder,
    contactIdentityResolver: {
      resolve: () => ({
        status: 'RESOLVED_EXISTING' as const,
        contactId: 'contact-opaque-live',
        contactIdentityId: 'identity-opaque-live'
      })
    },
    conversationResolver: {
      resolve: () => ({ status: 'RESOLVED_EXISTING' as const, conversationId: 'conversation-opaque-live' })
    },
    idempotencyStore: new InMemoryDurableIdempotencyStore(),
    ownerId: 'worker-opaque-001',
    now,
    leaseDurationMs: 30_000,
    createInternalEventId: () => 'gateway-event-opaque-001'
  };
}

function preparedMessage(overrides: Partial<PreparedOutboundMessage> = {}): PreparedOutboundMessage {
  return {
    internalMessageId: 'message-opaque-001',
    contactId: 'contact-opaque-001',
    contactIdentityId: 'identity-opaque-001',
    channel: 'WHATSAPP',
    provider: 'WHATSAPP_META_OFFICIAL',
    content: { contentType: 'TEXT', text: 'synthetic' },
    correlationId: 'correlation-opaque-001',
    state: 'PREPARED',
    ...overrides
  };
}

function gatewayTypescriptSource(): string {
  const root = path.resolve(process.cwd(), 'services/channel-gateway');
  const visit = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? entry.name === 'adapters' ? [] : visit(path.join(directory, entry.name))
      : entry.name.endsWith('.ts') ? [path.join(directory, entry.name)] : []);
  return visit(root).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

describe('F1B-07 Meta live prerequisites offline', () => {
  it('preserves exact raw bytes before and after strict JSON decoding', () => {
    const bytes = new TextEncoder().encode('{"technical":true,"n":1}');
    const request = createLiveWebhookRequest({
      method: 'post', rawBody: bytes, headers: { 'X-Mixed': ['a', 'b'] }, receivedAt: now,
      requestId: 'request-opaque-raw'
    });
    bytes[0] = 0;
    const decoded = decodeRawWebhookJson(request, 'WHATSAPP_META_OFFICIAL');

    expect(new TextDecoder().decode(request.rawBody)).toBe('{"technical":true,"n":1}');
    expect(decoded.rawBody).toEqual(request.rawBody);
    expect(decoded.value).toEqual({ technical: true, n: 1 });
    expect(request.headers['x-mixed']).toBe('a,b');
    expect(() => decodeRawWebhookJson(liveRequest('{invalid'), 'WHATSAPP_META_OFFICIAL'))
      .toThrowError('MALFORMED_REQUEST');
  });

  it('fails live authentication closed and invokes a decoder only after VERIFIED', () => {
    const decoder = new TestLiveDecoder();
    const missing = processLiveWebhookRequest(liveOptions(new UnconfiguredWebhookAuthenticator(), decoder));
    const rejected = processLiveWebhookRequest(liveOptions(new FixedAuthenticator('REJECTED'), decoder));
    const verified = processLiveWebhookRequest(liveOptions(new FixedAuthenticator('VERIFIED'), decoder));

    expect(missing.audit.reasonCode).toBe('WEBHOOK_AUTH_NOT_CONFIGURED');
    expect(rejected.audit.reasonCode).toBe('WEBHOOK_AUTH_REJECTED');
    expect(decoder.calls).toBe(1);
    expect(verified.outcome).toBe('ACCEPTED');
  });

  it('keeps the actual Meta live decoder blocked pending official protocol verification', () => {
    const result = processLiveWebhookRequest(
      liveOptions(new FixedAuthenticator('VERIFIED'), new WhatsAppMetaLiveDecoderPending())
    );
    expect(result.outcome).toBe('REJECTED');
    expect(result.audit.reasonCode).toBe('OFFICIAL_PROTOCOL_NOT_VERIFIED');
  });

  it('separates and strictly validates the internal synthetic Meta contract', () => {
    expect(decodeMetaSyntheticFixture(metaFixture()).kind).toBe('inbound_message');
    expect(() => decodeMetaSyntheticFixture(metaFixture({ provider: 'RCS_GOOGLE' })))
      .toThrowError('INVALID_EVENT');
    expect(() => decodeMetaSyntheticFixture(metaFixture({ channel: 'RCS' })))
      .toThrowError('INVALID_EVENT');
    expect(() => decodeMetaSyntheticFixture(metaFixture({ kind: undefined })))
      .toThrowError('INVALID_EVENT');
    expect(() => decodeMetaSyntheticFixture(metaFixture({ kind: 'unknown' })))
      .toThrowError('UNSUPPORTED_EVENT');
    expect(() => decodeMetaSyntheticFixture([])).toThrowError('INVALID_EVENT');
  });

  it('accepts and deduplicates only through the explicit trusted fixture entrypoint', () => {
    const store = new InMemoryDurableIdempotencyStore();
    const options = {
      adapter: new WhatsAppMetaOfflineAdapter(), rawFixture: metaFixture(),
      trustMode: 'TRUSTED_SYNTHETIC_FIXTURE' as const, idempotencyStore: store,
      ownerId: 'worker-opaque-001', now, leaseDurationMs: 30_000,
      createInternalEventId: () => 'gateway-event-opaque-synthetic'
    };
    const accepted = processTrustedSyntheticFixture(options);
    const duplicate = processTrustedSyntheticFixture({ ...options, ownerId: 'worker-opaque-002' });

    expect(accepted.outcome).toBe('ACCEPTED');
    expect(duplicate.outcome).toBe('DUPLICATE');
    expect(duplicate).not.toHaveProperty('command');
  });

  it('proves a generic injected digest primitive without embedding a secret', () => {
    const secret = randomBytes(32);
    const rawBody = new TextEncoder().encode('synthetic authenticated bytes');
    const digest = createHmac('sha256', secret).update(rawBody).digest();
    const verifier = new InjectedHmacDigestVerifier('sha256', secret);

    expect(verifier.verify({ rawBody, presentedDigest: digest })).toBe(true);
    expect(verifier.verify({ rawBody, presentedDigest: randomBytes(32) })).toBe(false);
    expect(verifier.verify({ rawBody, presentedDigest: randomBytes(4) })).toBe(false);
  });

  it('keeps the provider-neutral handshake explicitly unconfigured', () => {
    const result = new UnconfiguredWebhookHandshakeVerifier().verify({
      provider: 'WHATSAPP_META_OFFICIAL', requestId: 'request-opaque-handshake',
      fields: { technical: 'opaque' }, receivedAt: now
    });
    expect(result.status).toBe('NOT_CONFIGURED');
    expect(result.reasonCode).toBe('HANDSHAKE_NOT_CONFIGURED');
  });

  it('models durable acquisition, ownership, completion, failures, and lease recovery', () => {
    const store = new InMemoryDurableIdempotencyStore();
    const acquire = (key: string, ownerId: string, at: Date) => store.tryAcquire({
      key, ownerId, now: at, leaseDurationMs: 1_000
    });
    expect(acquire('k-processing', 'owner-a', now).status).toBe('ACQUIRED');
    expect(acquire('k-processing', 'owner-b', now).status).toBe('ALREADY_PROCESSING');
    expect(() => store.complete('k-processing', 'owner-b', now)).toThrowError('IDEMPOTENCY_OWNER_MISMATCH');
    const recovered = acquire('k-processing', 'owner-b', new Date(now.getTime() + 1_001));
    expect(recovered.status).toBe('RETRY_ALLOWED');
    expect(recovered.record.attempt).toBe(2);
    store.complete('k-processing', 'owner-b', now);
    expect(acquire('k-processing', 'owner-c', now).status).toBe('ALREADY_COMPLETED');

    acquire('k-retry', 'owner-a', now);
    expect(store.fail('k-retry', 'owner-a', now, 'RETRYABLE').state).toBe('FAILED_RETRYABLE');
    expect(acquire('k-retry', 'owner-b', now).status).toBe('RETRY_ALLOWED');
    acquire('k-final', 'owner-a', now);
    expect(store.fail('k-final', 'owner-a', now, 'NON_RETRYABLE').state).toBe('FAILED_FINAL');
    expect(acquire('k-final', 'owner-b', now).status).toBe('FINAL_FAILURE');
  });

  it('never auto-resolves missing or ambiguous identity and Conversation results', () => {
    expect(mayContinueAfterIdentityResolution({ status: 'AMBIGUOUS' })).toBe(false);
    expect(mayContinueAfterIdentityResolution({ status: 'NOT_FOUND' })).toBe(false);
    expect(mayContinueAfterIdentityResolution({ status: 'REJECTED', reasonCode: 'TECHNICAL' })).toBe(false);
    expect(mayContinueAfterConversationResolution({ status: 'AMBIGUOUS' })).toBe(false);
    expect(mayContinueAfterConversationResolution({ status: 'NOT_FOUND' })).toBe(false);
    expect(mayContinueAfterConversationResolution({ status: 'RESOLVED_EXISTING', conversationId: 'conv-opaque' }))
      .toBe(true);
    const identityAmbiguous = processLiveWebhookRequest({
      ...liveOptions(new FixedAuthenticator('VERIFIED'), new TestLiveDecoder()),
      contactIdentityResolver: { resolve: () => ({ status: 'AMBIGUOUS' }) }
    });
    const conversationMissing = processLiveWebhookRequest({
      ...liveOptions(new FixedAuthenticator('VERIFIED'), new TestLiveDecoder()),
      conversationResolver: { resolve: () => ({ status: 'NOT_FOUND' }) }
    });
    expect(identityAmbiguous.audit.reasonCode).toBe('IDENTITY_AMBIGUOUS');
    expect(conversationMissing.audit.reasonCode).toBe('CONVERSATION_NOT_FOUND');
  });

  it('enforces pure inbound and outbound state transition graphs', () => {
    expect(transitionInboundState('RECEIVED', 'AUTH_PENDING')).toBe('AUTH_PENDING');
    expect(() => transitionInboundState('RECEIVED', 'ACCEPTED')).toThrowError('INVALID_INBOUND_TRANSITION');
    expect(() => transitionInboundState('ACCEPTED', 'RECEIVED')).toThrowError('INVALID_INBOUND_TRANSITION');
    expect(transitionOutboundState('PREPARED', 'QUEUED')).toBe('QUEUED');
    expect(() => transitionOutboundState('CANCELLED', 'SENDING')).toThrowError('INVALID_OUTBOUND_TRANSITION');
    expect(() => transitionOutboundState('DELIVERED', 'SENDING')).toThrowError('INVALID_OUTBOUND_TRANSITION');
  });

  it('prevents duplicate enqueue, enforces exclusive reservation, and finalizes ack', () => {
    const queue = new InMemoryOutboundQueue();
    expect(queue.enqueue('q-1', preparedMessage(), now).status).toBe('ENQUEUED');
    expect(queue.enqueue('q-2', preparedMessage(), now).status).toBe('DUPLICATE');
    expect(queue.enqueue('q-3', preparedMessage({ internalMessageId: 'message-opaque-002' }), now).status)
      .toBe('DUPLICATE');
    expect(queue.reserve('q-1', 'owner-a', now, 1_000).status).toBe('RESERVED');
    expect(queue.reserve('q-1', 'owner-b', now, 1_000).status).toBe('NOT_AVAILABLE');
    expect(queue.ack('q-1', 'owner-a', now).state).toBe('DELIVERED');
    expect(queue.reserve('q-1', 'owner-c', now, 1_000).status).toBe('NOT_AVAILABLE');
  });

  it('applies bounded retry and never requeues final or cancelled outbound work', () => {
    const queue = new InMemoryOutboundQueue();
    queue.enqueue('q-retry', preparedMessage(), now);
    queue.reserve('q-retry', 'owner-a', now, 1_000);
    const retry = queue.nack('q-retry', 'owner-a', now, 'RATE_LIMITED', {
      maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500
    }, 300);
    expect(retry.state).toBe('QUEUED');
    expect(retry.nextAttemptAt?.getTime()).toBe(now.getTime() + 300);
    expect(queue.reserve('q-retry', 'owner-b', new Date(now.getTime() + 299), 1_000).status)
      .toBe('NOT_AVAILABLE');
    queue.reserve('q-retry', 'owner-b', new Date(now.getTime() + 300), 1_000);
    expect(queue.nack('q-retry', 'owner-b', now, 'RATE_LIMITED', {
      maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 500
    }).state).toBe('FAILED_FINAL');
    expect(queue.reserve('q-retry', 'owner-c', now, 1_000).status).toBe('NOT_AVAILABLE');

    queue.enqueue('q-cancel', preparedMessage({
      internalMessageId: 'message-opaque-cancel', correlationId: 'correlation-opaque-cancel'
    }), now);
    expect(queue.cancel('q-cancel').state).toBe('CANCELLED');
    expect(queue.reserve('q-cancel', 'owner-a', now, 1_000).status).toBe('NOT_AVAILABLE');
  });

  it('keeps failure, retry, rate-limit, observability, secret, and transport contracts neutral', () => {
    expect(classifyGatewayFailure('RATE_LIMITED')).toBe('RATE_LIMITED');
    expect(classifyGatewayFailure('MALFORMED_REQUEST')).toBe('MALFORMED_REQUEST');
    expect(calculateRetryDecision({
      attempt: 3, maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20, retryability: 'RETRYABLE'
    }).reason).toBe('MAX_ATTEMPTS_REACHED');
    expect(new ProviderHintRateLimitPolicy().selectDelayMs({
      category: 'RATE_LIMITED', retryAfterMs: 750, observedAt: now
    }, 100)).toBe(750);
    expect(durationBucket(1_000)).toBe('GTE_1_S');
    const metric = createGatewayMetricEvent({
      provider: 'WHATSAPP_META_OFFICIAL', channel: 'WHATSAPP', stage: 'DECODING',
      outcome: 'SUCCESS', reasonCode: 'EVENT_ACCEPTED', durationMs: 8,
      retryCount: 0, duplicate: false, correlationId: 'correlation-opaque-metric',
      timestamp: now.toISOString()
    });
    expect(Object.keys(metric).sort()).toEqual([
      'channel', 'correlationId', 'duplicate', 'durationBucket', 'outcome', 'provider',
      'reasonCode', 'retryCount', 'stage', 'timestamp'
    ]);
    const refs: ProviderSecretRefs = {
      authentication: { id: 'secret-ref-auth-opaque' },
      webhookVerification: { id: 'secret-ref-webhook-opaque' }
    };
    expect(JSON.stringify(refs)).not.toMatch(/value|material|token/i);
    expect(new UnconfiguredProviderTransport().sendPreparedMessage(preparedMessage()))
      .toEqual({ status: 'NOT_CONFIGURED', reasonCode: 'TRANSPORT_NOT_CONFIGURED' });
  });

  it('distinguishes process health from honest Meta live readiness', () => {
    const readiness = evaluateProviderLiveReadiness({
      provider: 'WHATSAPP_META_OFFICIAL',
      wabaSubscriptionConfigured: false,
      webhookVerifyTokenConfigured: false,
      httpsIngressConfigured: false,
      tlsCertificateConfigured: false,
      transportConfigured: false,
      durablePersistenceConfigured: false
    });
    expect(readiness.status).toBe('NOT_READY');
    expect(readiness.reasons).toEqual([
      'OFFICIAL_SIGNATURE_PROTOCOL_NOT_VERIFIED',
      'OFFICIAL_HANDSHAKE_PROTOCOL_NOT_VERIFIED',
      ...META_OFFLINE_LIVE_BLOCKERS,
      'WABA_SUBSCRIPTION_NOT_CONFIGURED',
      'WEBHOOK_VERIFY_TOKEN_NOT_CONFIGURED',
      'HTTPS_INGRESS_NOT_CONFIGURED',
      'TLS_CERTIFICATE_NOT_CONFIGURED',
      'TRANSPORT_NOT_CONFIGURED',
      'DURABLE_PERSISTENCE_NOT_CONFIGURED'
    ]);
    expect(evaluateProviderLiveReadiness({
      provider: 'WHATSAPP_META_OFFICIAL',
      officialSignatureProtocolVerified: true,
      officialHandshakeProtocolVerified: true,
      wabaSubscriptionConfigured: true,
      webhookVerifyTokenConfigured: true,
      httpsIngressConfigured: true,
      tlsCertificateConfigured: true,
      transportConfigured: true,
      durablePersistenceConfigured: true
    })).toEqual({
      provider: 'WHATSAPP_META_OFFICIAL', status: 'NOT_READY',
      reasons: [
        'OFFICIAL_SIGNATURE_PROTOCOL_NOT_VERIFIED',
        'OFFICIAL_HANDSHAKE_PROTOCOL_NOT_VERIFIED',
        ...META_OFFLINE_LIVE_BLOCKERS
      ]
    });
  });

  it('runs all Simulator V2 scenarios with a privacy-safe output allowlist', () => {
    const expected: Record<string, string[]> = {
      META_VALID_SYNTHETIC: ['ACCEPTED'],
      META_DUPLICATE: ['ACCEPTED', 'DUPLICATE'],
      META_INVALID: ['REJECTED'],
      META_AUTH_REJECTED: ['REJECTED'],
      META_LIVE_NOT_CONFIGURED: ['REJECTED'],
      RCS_SYNTHETIC_REGRESSION: ['ACCEPTED']
    };
    for (const [scenario, outcomes] of Object.entries(expected)) {
      const lines: string[] = [];
      executeGatewaySimulatorCli(['--scenario', scenario], (line) => lines.push(line));
      const outputs = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(outputs.map((output) => output.result)).toEqual(outcomes);
      for (const output of outputs) {
        expect(Object.keys(output).sort()).toEqual([
          'channel', 'correlationId', 'duplicate', 'eventType', 'provider', 'reason', 'result'
        ]);
        expect(JSON.stringify(output)).not.toMatch(/phone|name|email|text|payload|address|secret|token/i);
      }
    }
    expect(new RcsGoogleOfflineAdapter().normalizeEvent(
      loadSyntheticFixture('rcs-inbound-text.json'),
      { createInternalEventId: () => 'rcs-event-opaque' }
    ).eventType).toBe('INBOUND_MESSAGE');
  });

  it('enforces gateway architecture, privacy, and network isolation in source', () => {
    const source = gatewayTypescriptSource();
    expect(source).not.toMatch(/src[\\/]repositories|firebase|firestore|@google-cloud[\\/]firestore/i);
    expect(source).not.toMatch(/src[\\/](components|views)|react/i);
    expect(source).not.toMatch(/\bfetch\s*\(|\baxios\b|\bhttps?\.request\s*\(|\bWebSocket\b|\bSocket\b/);
    expect(source).not.toMatch(/graph\.facebook|facebook\.com|whatsapp[^\n]*endpoint|rcs[^\n]*endpoint/i);
    expect(source).not.toMatch(/(accessToken|client_secret|private_key|serviceAccount|password)\s*[:=]\s*['"][^'"]+/i);
    expect(source).not.toMatch(/create(Contact|Conversation|Order)\s*\(/);
  });
});
