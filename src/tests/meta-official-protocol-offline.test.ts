import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NormalizedChannelEvent } from '../../services/channel-gateway/contracts';
import { GatewayError } from '../../services/channel-gateway/errors';
import { InMemoryDurableIdempotencyStore } from '../../services/channel-gateway/idempotency';
import { processLiveWebhookRequest } from '../../services/channel-gateway/inbound';
import { evaluateProviderLiveReadiness, META_OFFLINE_LIVE_BLOCKERS } from '../../services/channel-gateway/operability';
import {
  WhatsAppMetaOfficialWebhookDecoder,
  createMetaOfficialProtocolReadinessContract,
  decodeMetaOfficialWebhookEvents,
  decodeMetaWebhookEnvelope,
  normalizeMetaOfficialProviderEvent
} from '../../services/channel-gateway/providers/metaOfficialProtocol';
import { WhatsAppMetaOfflineAdapter } from '../../services/channel-gateway/providers/whatsapp-meta';
import { createLiveWebhookRequest, type RawWebhookRequest } from '../../services/channel-gateway/rawWebhook';
import { executeGatewaySimulatorCli } from '../../services/channel-gateway/simulator/cli';
import type { WebhookAuthenticationResult, WebhookAuthenticator } from '../../services/channel-gateway/webhookAuth';

const now = new Date('2026-09-04T12:00:00.000Z');

function officialEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-synthetic-001',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '+15555550100',
                phone_number_id: 'phone-number-id-synthetic-001'
              },
              messages: [
                {
                  from: '+15555550123',
                  id: 'wamid.synthetic.inbound.001',
                  timestamp: '1788523200',
                  type: 'text',
                  text: { body: 'Synthetic official envelope message' }
                }
              ]
            }
          }
        ]
      }
    ],
    ...overrides
  };
}

function statusEnvelope(status: string, timestamp = '1788523200'): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-synthetic-001',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '+15555550100',
                phone_number_id: 'phone-number-id-synthetic-001'
              },
              statuses: [
                {
                  id: 'wamid.synthetic.outbound.001',
                  status,
                  timestamp
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

function firstNormalized(input: unknown): NormalizedChannelEvent {
  const decoded = decodeMetaOfficialWebhookEvents(input)[0];
  return normalizeMetaOfficialProviderEvent(decoded, {
    createInternalEventId: () => 'gateway-event-internal-001'
  });
}

function request(body: unknown): RawWebhookRequest {
  return createLiveWebhookRequest({
    method: 'POST',
    rawBody: new TextEncoder().encode(JSON.stringify(body)),
    receivedAt: now,
    requestId: 'request-official-opaque-001'
  });
}

class VerifiedAuthenticator implements WebhookAuthenticator {
  readonly provider = 'WHATSAPP_META_OFFICIAL' as const;
  readonly status = 'CONFIGURED' as const;

  verify(input: RawWebhookRequest): WebhookAuthenticationResult {
    return {
      status: 'VERIFIED',
      reasonCode: 'TEST_VERIFIED',
      provider: this.provider,
      requestId: input.requestId,
      evaluatedAt: now
    };
  }
}

function processOfficial(body: unknown) {
  return processLiveWebhookRequest({
    adapter: new WhatsAppMetaOfflineAdapter(),
    request: request(body),
    authenticator: new VerifiedAuthenticator(),
    liveDecoder: new WhatsAppMetaOfficialWebhookDecoder(),
    contactIdentityResolver: {
      resolve: () => ({
        status: 'RESOLVED_EXISTING',
        contactId: 'contact-internal-001',
        contactIdentityId: 'identity-internal-001'
      })
    },
    conversationResolver: {
      resolve: () => ({
        status: 'RESOLVED_EXISTING',
        conversationId: 'conversation-internal-001'
      })
    },
    idempotencyStore: new InMemoryDurableIdempotencyStore(),
    ownerId: 'worker-official-opaque-001',
    now,
    leaseDurationMs: 30_000,
    createInternalEventId: () => 'gateway-event-internal-001'
  });
}

function gatewaySource(): string {
  const root = path.resolve(process.cwd(), 'services/channel-gateway');
  const visit = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return visit(fullPath);
      return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
    });
  return visit(root).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

describe('F1B-08 Meta official protocol offline foundation', () => {
  it('accepts the official whatsapp_business_account object', () => {
    expect(decodeMetaWebhookEnvelope(officialEnvelope()).object).toBe('whatsapp_business_account');
  });

  it('rejects an incorrect object', () => {
    expect(() => decodeMetaWebhookEnvelope(officialEnvelope({ object: 'page' })))
      .toThrowError(new GatewayError('INVALID_EVENT'));
  });

  it('requires a non-empty entry array', () => {
    expect(() => decodeMetaWebhookEnvelope(officialEnvelope({ entry: undefined })))
      .toThrowError('INVALID_EVENT');
    expect(() => decodeMetaWebhookEnvelope(officialEnvelope({ entry: [] })))
      .toThrowError('INVALID_EVENT');
  });

  it('validates each entry changes array', () => {
    expect(() => decodeMetaWebhookEnvelope(officialEnvelope({
      entry: [{ id: 'waba-synthetic-001', changes: [] }]
    }))).toThrowError('INVALID_EVENT');
  });

  it('accepts the messages field', () => {
    expect(decodeMetaWebhookEnvelope(officialEnvelope()).entry[0].changes[0].field).toBe('messages');
  });

  it('rejects an incompatible field instead of treating it as a message', () => {
    expect(() => decodeMetaWebhookEnvelope(officialEnvelope({
      entry: [{ id: 'waba-synthetic-001', changes: [{ field: 'feed', value: {} }] }]
    }))).toThrowError('INVALID_EVENT');
  });

  it('requires messaging_product whatsapp', () => {
    const envelope = officialEnvelope();
    const change = (envelope.entry as any[])[0].changes[0];
    change.value.messaging_product = 'messenger';

    expect(() => decodeMetaWebhookEnvelope(envelope)).toThrowError('INVALID_EVENT');
  });

  it('validates metadata structure', () => {
    const envelope = officialEnvelope();
    const change = (envelope.entry as any[])[0].changes[0];
    change.value.metadata = { phone_number_id: 'phone-number-id-synthetic-001' };

    expect(() => decodeMetaWebhookEnvelope(envelope)).toThrowError('INVALID_EVENT');
  });

  it('decodes the inbound synthetic official envelope', () => {
    const decoded = decodeMetaOfficialWebhookEvents(officialEnvelope());

    expect(decoded[0]).toMatchObject({
      kind: 'message',
      providerMessageId: 'wamid.synthetic.inbound.001'
    });
  });

  it('preserves providerMessageId', () => {
    expect(firstNormalized(officialEnvelope()).providerMessageId).toBe('wamid.synthetic.inbound.001');
  });

  it('keeps the internal event ID separate from providerMessageId', () => {
    const event = firstNormalized(officialEnvelope());

    expect(event.internalEventId).toBe('gateway-event-internal-001');
    expect(event.internalEventId).not.toBe(event.providerMessageId);
  });

  it('decodes sent status to provider-neutral delivery status', () => {
    expect(firstNormalized(statusEnvelope('sent')).payload.deliveryStatus).toBe('SENT');
  });

  it('decodes delivered status to provider-neutral delivery status', () => {
    expect(firstNormalized(statusEnvelope('delivered')).payload.deliveryStatus).toBe('DELIVERED');
  });

  it('decodes read status to provider-neutral read status', () => {
    const event = firstNormalized(statusEnvelope('read'));

    expect(event.eventType).toBe('READ_STATUS');
    expect(event.payload.readStatus).toBe('READ');
  });

  it('decodes failed status to provider-neutral delivery status', () => {
    expect(firstNormalized(statusEnvelope('failed')).payload.deliveryStatus).toBe('FAILED');
  });

  it('preserves and normalizes provider timestamp', () => {
    const event = firstNormalized(statusEnvelope('delivered', '1788523202'));

    expect(event.payload.providerTimestamp).toBe('1788523202');
    expect(event.occurredAt.toISOString()).toBe(new Date(1788523202 * 1_000).toISOString());
  });

  it('does not sort status arrival order as chronological truth', () => {
    const envelope = statusEnvelope('read', '200');
    const change = (envelope.entry as any[])[0].changes[0];
    change.value.statuses.push({
      id: 'wamid.synthetic.outbound.001',
      status: 'delivered',
      timestamp: '100'
    });

    const events = decodeMetaOfficialWebhookEvents(envelope);

    expect(events.map((event) => event.kind === 'status' ? event.status : event.kind)).toEqual(['read', 'delivered']);
    expect(events.map((event) => event.kind === 'status' ? event.providerTimestamp : '')).toEqual(['200', '100']);
  });

  it('classifies unsupported official event shapes', () => {
    const envelope = officialEnvelope();
    const message = (envelope.entry as any[])[0].changes[0].value.messages[0];
    message.type = 'image';
    delete message.text;

    expect(decodeMetaOfficialWebhookEvents(envelope)[0]).toMatchObject({
      kind: 'unsupported_event',
      reason: 'UNSUPPORTED_MESSAGE_TYPE'
    });
    expect(processOfficial(envelope).audit.reasonCode).toBe('UNSUPPORTED_EVENT');
  });

  it('fails closed for malformed message and malformed JSON', () => {
    const envelope = officialEnvelope();
    const change = (envelope.entry as any[])[0].changes[0];
    change.value.messages = [{}];

    expect(() => decodeMetaOfficialWebhookEvents(envelope)).toThrowError('INVALID_EVENT');
    expect(() => new WhatsAppMetaOfficialWebhookDecoder().decode(
      createLiveWebhookRequest({
        method: 'POST',
        rawBody: new TextEncoder().encode('{not-json'),
        receivedAt: now,
        requestId: 'request-official-malformed'
      }),
      { createInternalEventId: () => 'gateway-event-internal-001' }
    )).toThrowError('MALFORMED_REQUEST');
  });

  it('does not turn raw payload into a CRM entity', () => {
    const result = processOfficial(officialEnvelope());

    expect(result.outcome).toBe('ACCEPTED');
    if (result.outcome === 'ACCEPTED') {
      expect(result.event).not.toHaveProperty('contact');
      expect(result.event).not.toHaveProperty('conversation');
      expect(result.event).not.toHaveProperty('order');
      expect(result.command.event.payload).not.toHaveProperty('rawPayload');
    }
  });

  it('keeps WABA subscription as offline configuration without management auth', () => {
    const contract = createMetaOfficialProtocolReadinessContract();

    expect(contract.wabaSubscription).toEqual({
      provider: 'WHATSAPP_META_OFFICIAL',
      required: true,
      configured: false,
      managementAuthentication: 'NOT_CONFIGURED'
    });
  });

  it('models verify token as a SecretRef rather than secret material', () => {
    const contract = createMetaOfficialProtocolReadinessContract({ id: 'secret-ref-meta-verify-token' });
    const serialized = JSON.stringify(contract.webhookVerifyToken);

    expect(contract.webhookVerifyToken.verifyTokenRef).toEqual({ id: 'secret-ref-meta-verify-token' });
    expect(contract.webhookVerifyToken).not.toHaveProperty('value');
    expect(serialized).not.toMatch(/secret-value|material|plain/i);
  });

  it('keeps HTTPS ingress and TLS certificate as readiness requirements', () => {
    const readiness = evaluateProviderLiveReadiness({
      provider: 'WHATSAPP_META_OFFICIAL',
      wabaSubscriptionConfigured: true,
      webhookVerifyTokenConfigured: true,
      httpsIngressConfigured: false,
      tlsCertificateConfigured: false,
      transportConfigured: true,
      durablePersistenceConfigured: true
    });

    expect(readiness.reasons).toContain('HTTPS_INGRESS_NOT_CONFIGURED');
    expect(readiness.reasons).toContain('TLS_CERTIFICATE_NOT_CONFIGURED');
  });

  it('keeps Meta POST signature protocol pending', () => {
    expect(createMetaOfficialProtocolReadinessContract().metaPostSignatureProtocol)
      .toBe('PENDING_OFFICIAL_SPEC_VERIFICATION');
  });

  it('keeps Meta live NOT_READY despite the official envelope decoder', () => {
    const readiness = evaluateProviderLiveReadiness({
      provider: 'WHATSAPP_META_OFFICIAL',
      officialSignatureProtocolVerified: true,
      officialHandshakeProtocolVerified: true,
      wabaSubscriptionConfigured: true,
      webhookVerifyTokenConfigured: true,
      httpsIngressConfigured: true,
      tlsCertificateConfigured: true,
      transportConfigured: true,
      durablePersistenceConfigured: true
    });

    expect(readiness).toEqual({
      provider: 'WHATSAPP_META_OFFICIAL',
      status: 'NOT_READY',
      reasons: [
        'OFFICIAL_SIGNATURE_PROTOCOL_NOT_VERIFIED',
        'OFFICIAL_HANDSHAKE_PROTOCOL_NOT_VERIFIED',
        ...META_OFFLINE_LIVE_BLOCKERS
      ]
    });
  });

  it('contains no Graph API call in executable gateway code', () => {
    expect(gatewaySource()).not.toMatch(/graph\.facebook|graph api|facebook\.com/i);
  });

  it('contains no fetch, http, axios, or WebSocket transport in executable gateway code', () => {
    expect(gatewaySource()).not.toMatch(/\bfetch\s*\(|\baxios\b|\bhttps?\.request\s*\(|\bWebSocket\b|\bSocket\b/);
  });

  it('runs official envelope simulator scenarios with sanitized output', () => {
    const expected: Record<string, string> = {
      META_OFFICIAL_INBOUND: 'INBOUND_MESSAGE',
      META_OFFICIAL_STATUS_SENT: 'DELIVERY_STATUS',
      META_OFFICIAL_STATUS_DELIVERED: 'DELIVERY_STATUS',
      META_OFFICIAL_STATUS_READ: 'READ_STATUS',
      META_OFFICIAL_STATUS_FAILED: 'DELIVERY_STATUS'
    };

    for (const [scenario, eventType] of Object.entries(expected)) {
      const lines: string[] = [];
      const exitCode = executeGatewaySimulatorCli(['--scenario', scenario], (line) => lines.push(line));
      const output = JSON.parse(lines[0]) as Record<string, unknown>;

      expect(exitCode).toBe(0);
      expect(output.eventType).toBe(eventType);
      expect(output.result).toBe('ACCEPTED');
      expect(JSON.stringify(output)).not.toMatch(/payload|address|text|phone|token|secret/i);
    }
  });
});
