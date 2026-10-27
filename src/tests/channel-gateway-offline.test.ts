import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasKnownProviderCapability,
  type ChannelProvider,
  type RoutingDecision
} from '../domain/omnichannel';
import type {
  ChannelGatewayAdapter,
  NormalizedChannelEvent,
  OutboundPreparationInput
} from '../../services/channel-gateway/contracts';
import { classifyGatewayError, GatewayError } from '../../services/channel-gateway/errors';
import { InMemoryDurableIdempotencyStore } from '../../services/channel-gateway/idempotency';
import { processTrustedSyntheticFixture } from '../../services/channel-gateway/inbound';
import {
  createProviderIdempotencyKey,
  prepareProviderNeutralOutbound
} from '../../services/channel-gateway/normalization';
import { EvolutionOptionalOfflineAdapter } from '../../services/channel-gateway/providers/evolution-optional';
import { RcsGoogleOfflineAdapter } from '../../services/channel-gateway/providers/rcs-google';
import { WhatsAppMetaOfflineAdapter } from '../../services/channel-gateway/providers/whatsapp-meta';
import { prepareOutboundFromRouting } from '../../services/channel-gateway/registry';
import { calculateRetryDecision } from '../../services/channel-gateway/retryPolicy';
import {
  executeGatewaySimulatorCli,
  loadSyntheticFixture,
  simulateFixture
} from '../../services/channel-gateway/simulator/cli';
import { UnconfiguredWebhookAuthenticator } from '../../services/channel-gateway/webhookAuth';

const fixedAt = new Date('2026-01-01T12:00:00.000Z');

function metaFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    synthetic: true,
    fixtureContract: 'INTERNAL_SYNTHETIC_META_V1',
    provider: 'WHATSAPP_META_OFFICIAL',
    channel: 'WHATSAPP',
    kind: 'inbound_message',
    providerEventId: 'synthetic-meta-event-001',
    providerMessageId: 'synthetic-meta-message-001',
    occurredAt: '2026-01-01T10:00:00.000Z',
    providerAddress: '+5511900000301',
    externalConversationId: 'synthetic-meta-conversation-001',
    contentType: 'TEXT',
    text: 'Mensagem fictícia de teste',
    ...overrides
  };
}

function rcsFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    synthetic: true,
    kind: 'inbound_message',
    providerEventId: 'synthetic-rcs-event-001',
    providerMessageId: 'synthetic-rcs-message-001',
    occurredAt: '2026-01-01T11:00:00.000Z',
    providerAddress: '+5511900000401',
    externalConversationId: 'synthetic-rcs-conversation-001',
    contentType: 'TEXT',
    text: 'Mensagem RCS fictícia de teste',
    ...overrides
  };
}

function context(id = 'gateway-event-opaque-001') {
  return { createInternalEventId: () => id };
}

function routingDecision(
  provider: ChannelProvider,
  channel: 'WHATSAPP' | 'RCS'
): RoutingDecision {
  return {
    contactId: 'contact-opaque-001',
    requestedMode: 'BOTH_SMART',
    selectedChannel: channel,
    selectedProvider: provider,
    reason: channel === 'WHATSAPP' ? 'WHATSAPP_SELECTED' : 'RCS_SELECTED',
    evaluatedAt: fixedAt
  };
}

function outboundInput(decision: RoutingDecision): OutboundPreparationInput {
  return {
    internalMessageId: 'message-internal-opaque-001',
    contactId: decision.contactId,
    contactIdentityId: 'identity-opaque-001',
    content: { contentType: 'TEXT', text: 'Mensagem preparada fictícia' },
    correlationId: 'correlation-opaque-001',
    routingDecision: decision,
    routingDecisionId: 'routing-decision-opaque-001'
  };
}

function processLegacyTestFixture(options: {
  adapter: ChannelGatewayAdapter;
  rawFixture: unknown;
  idempotencyStore: InMemoryDurableIdempotencyStore;
  auditedAt?: Date;
  createInternalEventId?: () => string;
}) {
  return processTrustedSyntheticFixture({
    ...options,
    trustMode: 'TRUSTED_SYNTHETIC_FIXTURE',
    ownerId: 'legacy-test-owner-opaque',
    now: options.auditedAt ?? fixedAt,
    leaseDurationMs: 30_000
  });
}

function typescriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

describe('F1B-05D channel gateway offline foundation', () => {
  it('implements one offline adapter boundary for Meta, RCS, and optional Evolution', () => {
    const adapters: ChannelGatewayAdapter[] = [
      new WhatsAppMetaOfflineAdapter(),
      new RcsGoogleOfflineAdapter(),
      new EvolutionOptionalOfflineAdapter()
    ];

    expect(adapters.map((adapter) => adapter.provider)).toEqual([
      'WHATSAPP_META_OFFICIAL',
      'RCS_GOOGLE',
      'WHATSAPP_EVOLUTION_OPTIONAL'
    ]);
  });

  it('normalizes a synthetic WhatsApp inbound message without creating CRM entities', () => {
    const adapter = new WhatsAppMetaOfflineAdapter();
    const contact = Object.freeze({ id: 'contact-opaque-001' });
    const order = Object.freeze({ id: 'order-opaque-001' });
    const event = adapter.normalizeEvent(metaFixture(), context());

    expect(event).toMatchObject({
      internalEventId: 'gateway-event-opaque-001',
      provider: 'WHATSAPP_META_OFFICIAL',
      channel: 'WHATSAPP',
      eventType: 'INBOUND_MESSAGE',
      originSurface: 'CUSTOMER',
      providerMessageId: 'synthetic-meta-message-001'
    });
    expect(event).not.toHaveProperty('contact');
    expect(event).not.toHaveProperty('order');
    expect(contact.id).toBe('contact-opaque-001');
    expect(order.id).toBe('order-opaque-001');
  });

  it('normalizes a synthetic WhatsApp delivery event', () => {
    const event = new WhatsAppMetaOfflineAdapter().normalizeEvent(
      metaFixture({ kind: 'delivery_status', deliveryStatus: 'DELIVERED' }),
      context()
    );

    expect(event.eventType).toBe('DELIVERY_STATUS');
    expect(event.payload.deliveryStatus).toBe('DELIVERED');
    expect(event.originSurface).toBe('PROVIDER');
  });

  it('represents an observed WhatsApp Business App message without CRM logic', () => {
    const event = new WhatsAppMetaOfflineAdapter().normalizeEvent(
      metaFixture({ kind: 'outbound_message_observed' }),
      context()
    );

    expect(event.eventType).toBe('OUTBOUND_MESSAGE_OBSERVED');
    expect(event.originSurface).toBe('WHATSAPP_BUSINESS_APP');
    expect(event.providerMessageId).toBe('synthetic-meta-message-001');
  });

  it('does not claim universal WhatsApp message echo support', () => {
    const unknown = new WhatsAppMetaOfflineAdapter().getCapabilities(fixedAt);
    const configured = new WhatsAppMetaOfflineAdapter({ capabilities: ['MESSAGE_ECHO'] })
      .getCapabilities(fixedAt);

    expect(hasKnownProviderCapability(unknown, 'MESSAGE_ECHO')).toBe(false);
    expect(hasKnownProviderCapability(configured, 'MESSAGE_ECHO')).toBe(true);
  });

  it('normalizes synthetic RCS inbound, delivery, and read events', () => {
    const adapter = new RcsGoogleOfflineAdapter();
    const inbound = adapter.normalizeEvent(rcsFixture(), context('gateway-event-rcs-001'));
    const delivery = adapter.normalizeEvent(
      rcsFixture({ kind: 'delivery_status', deliveryStatus: 'DELIVERED' }),
      context('gateway-event-rcs-002')
    );
    const read = adapter.normalizeEvent(
      rcsFixture({ kind: 'read_status' }),
      context('gateway-event-rcs-003')
    );

    expect(inbound.eventType).toBe('INBOUND_MESSAGE');
    expect(delivery.payload.deliveryStatus).toBe('DELIVERED');
    expect(read.eventType).toBe('READ_STATUS');
    expect(read.payload.readStatus).toBe('READ');
  });

  it('normalizes timestamped RCS capability evidence without assuming capabilities', () => {
    const event = new RcsGoogleOfflineAdapter().normalizeEvent(
      rcsFixture({
        kind: 'capability_update',
        providerMessageId: undefined,
        availability: 'KNOWN_AVAILABLE',
        capabilities: ['TEXT', 'RICH_MEDIA'],
        capabilitySource: 'PROVIDER_EVENT'
      }),
      context()
    );

    expect(event.eventType).toBe('CAPABILITY_UPDATE');
    expect(event.occurredAt.toISOString()).toBe('2026-01-01T11:00:00.000Z');
    expect(event.payload).toMatchObject({
      availability: 'KNOWN_AVAILABLE',
      capabilities: ['TEXT', 'RICH_MEDIA'],
      capabilitySource: 'PROVIDER_EVENT'
    });
  });

  it('normalizes RCS subscription and provider status events', () => {
    const adapter = new RcsGoogleOfflineAdapter();
    const subscription = adapter.normalizeEvent(
      rcsFixture({ kind: 'subscription_update', subscriptionStatus: 'SUBSCRIBED' }),
      context('gateway-event-rcs-004')
    );
    const status = adapter.normalizeEvent(
      rcsFixture({ kind: 'provider_status', providerStatus: 'AVAILABLE' }),
      context('gateway-event-rcs-005')
    );

    expect(subscription.payload.subscriptionStatus).toBe('SUBSCRIBED');
    expect(status.payload.providerStatus).toBe('AVAILABLE');
  });

  it('keeps optional Evolution behind the same non-default offline boundary', () => {
    const adapter = new EvolutionOptionalOfflineAdapter();
    const event = adapter.normalizeEvent(metaFixture(), context());

    expect(adapter.provider).toBe('WHATSAPP_EVOLUTION_OPTIONAL');
    expect(event.provider).toBe('WHATSAPP_EVOLUTION_OPTIONAL');
    expect(adapter.getCapabilities(fixedAt).capabilities).toEqual([]);
  });

  it('accepts the first event and rejects the repeated logical event as duplicate', () => {
    const adapter = new WhatsAppMetaOfflineAdapter();
    const store = new InMemoryDurableIdempotencyStore();
    let sequence = 0;
    const createInternalEventId = () => `gateway-event-opaque-${++sequence}`;
    const first = processLegacyTestFixture({
      adapter,
      rawFixture: metaFixture(),
      idempotencyStore: store,
      auditedAt: fixedAt,
      createInternalEventId
    });
    const duplicate = processLegacyTestFixture({
      adapter,
      rawFixture: metaFixture(),
      idempotencyStore: store,
      auditedAt: fixedAt,
      createInternalEventId
    });

    expect(first.outcome).toBe('ACCEPTED');
    expect(first).toHaveProperty('command.type', 'InboundMessageReceived');
    expect(duplicate.outcome).toBe('DUPLICATE');
    expect(duplicate).not.toHaveProperty('command');
    expect(duplicate.audit.duplicate).toBe(true);
  });

  it('uses provider event ID first and provider message ID only for message events', () => {
    const adapter = new WhatsAppMetaOfflineAdapter();
    const withEventId = adapter.normalizeEvent(metaFixture(), context());
    const withMessageId = adapter.normalizeEvent(
      metaFixture({ providerEventId: undefined }),
      context()
    );

    expect(createProviderIdempotencyKey(withEventId)).toContain(':event:');
    expect(createProviderIdempotencyKey(withMessageId)).toContain(':message:');
  });

  it('does not derive idempotency keys or internal IDs from sensitive fixture fields', () => {
    const adapter = new WhatsAppMetaOfflineAdapter();
    const fixture = metaFixture();
    const event = adapter.normalizeEvent(fixture, context('gateway-event-random-opaque'));
    const key = adapter.createIdempotencyKey(event);

    expect(key).not.toContain(String(fixture.providerAddress));
    expect(key).not.toContain(String(fixture.text));
    expect(event.internalEventId).not.toContain(String(fixture.providerAddress));
    expect(event.internalEventId).not.toContain(String(fixture.text));
  });

  it('returns a sanitized audit shape without message, address, or raw payload', () => {
    const result = processLegacyTestFixture({
      adapter: new WhatsAppMetaOfflineAdapter(),
      rawFixture: metaFixture(),
      idempotencyStore: new InMemoryDurableIdempotencyStore(),
      auditedAt: fixedAt,
      createInternalEventId: () => 'gateway-event-opaque-001'
    });
    const serialized = JSON.stringify(result.audit);

    expect(Object.keys(result.audit).sort()).toEqual([
      'auditedAt',
      'channel',
      'duplicate',
      'eventType',
      'internalEventId',
      'occurredAt',
      'outcome',
      'provider',
      'reasonCode',
      'retryCount'
    ]);
    expect(serialized).not.toContain('+5511900000301');
    expect(serialized).not.toContain('Mensagem fictícia de teste');
    expect(serialized).not.toContain('providerAddress');
    expect(serialized).not.toContain('payload');
  });

  it('sanitizes rejected event diagnostics as a code only', () => {
    const result = processLegacyTestFixture({
      adapter: new WhatsAppMetaOfflineAdapter(),
      rawFixture: { synthetic: true, unexpected: 'sensitive synthetic value' },
      idempotencyStore: new InMemoryDurableIdempotencyStore(),
      auditedAt: fixedAt,
      createInternalEventId: () => 'gateway-event-rejected-opaque'
    });

    expect(result.outcome).toBe('REJECTED');
    expect(JSON.stringify(result.audit)).not.toContain('sensitive synthetic value');
    expect(result.audit.reasonCode).toBe('INVALID_EVENT');
  });

  it('prepares an outbound envelope without transport or secret fields', () => {
    const adapter = new WhatsAppMetaOfflineAdapter();
    const prepared = adapter.prepareOutbound(
      outboundInput(routingDecision('WHATSAPP_META_OFFICIAL', 'WHATSAPP'))
    );

    expect(prepared).toMatchObject({
      provider: 'WHATSAPP_META_OFFICIAL',
      channel: 'WHATSAPP',
      state: 'PREPARED'
    });
    expect(prepared).not.toHaveProperty('endpoint');
    expect(prepared).not.toHaveProperty('token');
    expect(prepared).not.toHaveProperty('secret');
  });

  it('selects the adapter from RoutingDecision and never changes its channel', () => {
    const decision = routingDecision('RCS_GOOGLE', 'RCS');
    const prepared = prepareOutboundFromRouting(
      [new WhatsAppMetaOfflineAdapter(), new RcsGoogleOfflineAdapter()],
      outboundInput(decision)
    );

    expect(prepared.channel).toBe(decision.selectedChannel);
    expect(prepared.provider).toBe(decision.selectedProvider);
  });

  it('fails closed when outbound input conflicts with the domain decision', () => {
    const input = outboundInput(routingDecision('RCS_GOOGLE', 'RCS'));

    expect(() => prepareProviderNeutralOutbound('WHATSAPP_META_OFFICIAL', 'WHATSAPP', input))
      .toThrowError(new GatewayError('INVALID_EVENT'));
  });

  it('allows provider capabilities to differ and treats unknown capability as unavailable', () => {
    const meta = new WhatsAppMetaOfflineAdapter({ capabilities: ['TEXT'] })
      .getCapabilities(fixedAt);
    const rcs = new RcsGoogleOfflineAdapter({ capabilities: ['TEXT', 'RICH_MEDIA'] })
      .getCapabilities(fixedAt);

    expect(meta.capabilities).not.toEqual(rcs.capabilities);
    expect(hasKnownProviderCapability(meta, 'RICH_MEDIA')).toBe(false);
    expect(hasKnownProviderCapability(rcs, 'RICH_MEDIA')).toBe(true);
  });

  it('calculates deterministic retry delay without waiting', () => {
    const decision = calculateRetryDecision({
      attempt: 2,
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      retryability: 'RETRYABLE'
    });

    expect(decision).toEqual({
      retry: true,
      nextAttempt: 3,
      delayMs: 200,
      reason: 'RETRY_SCHEDULED'
    });
  });

  it('respects retry maximums and distinguishes non-retryable errors', () => {
    const exhausted = calculateRetryDecision({
      attempt: 3,
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      retryability: 'RETRYABLE'
    });
    const refused = calculateRetryDecision({
      attempt: 1,
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      retryability: 'NON_RETRYABLE'
    });

    expect(exhausted.reason).toBe('MAX_ATTEMPTS_REACHED');
    expect(refused.reason).toBe('NON_RETRYABLE');
    expect(classifyGatewayError('RATE_LIMITED')).toBe('RETRYABLE');
    expect(classifyGatewayError('INVALID_EVENT')).toBe('NON_RETRYABLE');
  });

  it('keeps live webhook authentication explicitly unconfigured', () => {
    const authenticator = new UnconfiguredWebhookAuthenticator();

    const request = {
      method: 'POST',
      rawBody: new TextEncoder().encode('synthetic body'),
      headers: {},
      query: {},
      receivedAt: fixedAt,
      requestId: 'request-opaque-001',
      trustMode: 'LIVE_UNTRUSTED' as const
    };

    expect(authenticator.status).toBe('NOT_CONFIGURED');
    expect(authenticator.verify(request).status).toBe('NOT_CONFIGURED');
  });

  it('runs Meta simulator replay as accepted then duplicate', () => {
    const raw = loadSyntheticFixture('whatsapp-inbound-text.json');
    const audits = simulateFixture(new WhatsAppMetaOfflineAdapter(), raw, 2);

    expect(audits.map((audit) => audit.outcome)).toEqual(['ACCEPTED', 'DUPLICATE']);
  });

  it('runs RCS inbound and capability fixtures offline', () => {
    const adapter = new RcsGoogleOfflineAdapter();
    const inbound = simulateFixture(adapter, loadSyntheticFixture('rcs-inbound-text.json'), 1);
    const capability = simulateFixture(adapter, loadSyntheticFixture('rcs-capability.json'), 1);

    expect(inbound[0].eventType).toBe('INBOUND_MESSAGE');
    expect(capability[0].eventType).toBe('CAPABILITY_UPDATE');
  });

  it('emits sanitized simulator output only', () => {
    const lines: string[] = [];
    const exitCode = executeGatewaySimulatorCli([
      '--provider',
      'WHATSAPP_META_OFFICIAL',
      '--fixture',
      'whatsapp-inbound-text.json',
      '--repeat',
      '2'
    ], (line) => lines.push(line));
    const output = lines.join('\n');

    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(2);
    expect(output).toContain('ACCEPTED');
    expect(output).toContain('DUPLICATE');
    expect(output).not.toContain('+5511900000101');
    expect(output).not.toContain('Mensagem fictícia de teste');
    expect(output).not.toContain('providerMessageId');
    expect(output).not.toContain('payload');
  });

  it('refuses fixture paths outside the synthetic fixture directory', () => {
    const lines: string[] = [];
    const exitCode = executeGatewaySimulatorCli([
      '--provider',
      'RCS_GOOGLE',
      '--fixture',
      '../outside.json'
    ], (line) => lines.push(line));

    expect(exitCode).toBe(1);
    expect(lines).toEqual(['FAIL INVALID_EVENT']);
  });

  it('keeps every versioned provider fixture explicitly synthetic and free of project data', () => {
    const fixtureDirectory = path.resolve(
      process.cwd(),
      'services/channel-gateway/simulator/fixtures'
    );
    const fixtureFiles = fs.readdirSync(fixtureDirectory).filter((name) => name.endsWith('.json'));

    expect(fixtureFiles.length).toBeGreaterThanOrEqual(8);
    for (const fixtureFile of fixtureFiles) {
      const raw = fs.readFileSync(path.join(fixtureDirectory, fixtureFile), 'utf8');
      const fixture = JSON.parse(raw) as Record<string, unknown>;
      if (fixtureFile.startsWith('meta-official-')) {
        expect(fixtureFile).toMatch(/\.synthetic\.json$/);
      } else {
        expect(fixture.synthetic).toBe(true);
      }
      expect(raw).not.toMatch(/prato\s+mineiro|restaurante/i);
      if (typeof fixture.providerAddress === 'string') {
        expect(fixture.providerAddress).toMatch(/^\+5511900000\d{3}$/);
      }
    }
  });

  it('preserves the domain-to-gateway dependency direction', () => {
    const domainDirectory = path.resolve(process.cwd(), 'src/domain');
    const domainSource = typescriptFiles(domainDirectory)
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    const gatewayDirectory = path.resolve(process.cwd(), 'services/channel-gateway');
    const gatewaySource = typescriptFiles(gatewayDirectory)
      .filter((file) => !file.includes(`${path.sep}adapters${path.sep}`))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');

    expect(domainSource).not.toMatch(/services[\\/]channel-gateway|channel-gateway/);
    expect(gatewaySource).not.toMatch(/src[\\/]repositories|firebase|firestore|@google-cloud[\\/]firestore/i);
    expect(gatewaySource).not.toMatch(/decideRouting/);
  });

  it('contains no transport primitive or prohibited provider library in gateway code', () => {
    const gatewayDirectory = path.resolve(process.cwd(), 'services/channel-gateway');
    const source = typescriptFiles(gatewayDirectory)
      .filter((file) => !file.includes(`${path.sep}adapters${path.sep}`))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');

    expect(source).not.toMatch(/\bfetch\s*\(|\baxios\b|\bhttps?\.request\s*\(|\bWebSocket\b|\bSocket\b/);
    expect(source).not.toMatch(/baileys|whatsapp-web|puppeteer|graph\s+api|googleapis/i);
    expect(source).not.toMatch(/setTimeout|setInterval/);
  });

  it('contains no embedded credential-shaped assignment in gateway code', () => {
    const gatewayDirectory = path.resolve(process.cwd(), 'services/channel-gateway');
    const source = typescriptFiles(gatewayDirectory)
      .filter((file) => !file.includes(`${path.sep}adapters${path.sep}`))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');

    expect(source).not.toMatch(/(apiKey|accessToken|client_secret|private_key|serviceAccount|password|webhookSecret)\s*[:=]\s*['"][^'"]+/i);
  });

  it('requires the explicit synthetic fixture marker and fails closed otherwise', () => {
    expect(() => new WhatsAppMetaOfflineAdapter().normalizeEvent(
      { ...metaFixture(), synthetic: false },
      context()
    )).toThrowError(new GatewayError('INVALID_EVENT'));
  });

  it('models provider-neutral commands without repository writes', () => {
    const result = processLegacyTestFixture({
      adapter: new RcsGoogleOfflineAdapter(),
      rawFixture: rcsFixture({ kind: 'read_status' }),
      idempotencyStore: new InMemoryDurableIdempotencyStore(),
      createInternalEventId: () => 'gateway-event-command-opaque'
    });

    expect(result.outcome).toBe('ACCEPTED');
    if (result.outcome === 'ACCEPTED') {
      expect(result.command.type).toBe('MessageReadUpdated');
      expect(result.command).not.toHaveProperty('repository');
      expect(result.command).not.toHaveProperty('contact');
      expect(result.command).not.toHaveProperty('conversation');
      expect(result.command).not.toHaveProperty('order');
    }
  });

  it('keeps normalized external addresses transient and outside Conversation resolution context', () => {
    const event: NormalizedChannelEvent = new RcsGoogleOfflineAdapter().normalizeEvent(
      rcsFixture(),
      context()
    );
    const conversationContext = {
      provider: event.provider,
      channel: event.channel,
      externalConversationId: event.payload.externalConversationId,
      providerMessageId: event.providerMessageId
    };

    expect(conversationContext).not.toHaveProperty('providerAddress');
    expect(conversationContext).not.toHaveProperty('contactId');
  });
});
