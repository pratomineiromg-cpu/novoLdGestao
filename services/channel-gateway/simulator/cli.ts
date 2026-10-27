import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChannelProvider } from '../../../src/domain/omnichannel';
import type { ChannelGatewayAdapter, GatewayAuditEvent } from '../contracts';
import { GatewayError } from '../errors';
import { InMemoryDurableIdempotencyStore } from '../idempotency';
import { processLiveWebhookRequest, processTrustedSyntheticFixture } from '../inbound';
import { EvolutionOptionalOfflineAdapter } from '../providers/evolution-optional';
import { WhatsAppMetaOfficialWebhookDecoder } from '../providers/metaOfficialProtocol';
import { RcsGoogleOfflineAdapter } from '../providers/rcs-google';
import {
  WhatsAppMetaLiveDecoderPending,
  WhatsAppMetaOfflineAdapter
} from '../providers/whatsapp-meta';
import { createLiveWebhookRequest } from '../rawWebhook';
import type { RawWebhookRequest } from '../rawWebhook';
import type {
  WebhookAuthenticationResult,
  WebhookAuthenticationStatus,
  WebhookAuthenticator
} from '../webhookAuth';
import { UnconfiguredWebhookAuthenticator } from '../webhookAuth';

const FIXTURE_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures'
);

interface SimulatorArguments {
  provider?: ChannelProvider;
  fixture?: string;
  repeat: number;
  scenario?: SimulatorScenario;
}

type SimulatorScenario =
  | 'META_VALID_SYNTHETIC'
  | 'META_DUPLICATE'
  | 'META_INVALID'
  | 'META_AUTH_REJECTED'
  | 'META_LIVE_NOT_CONFIGURED'
  | 'META_OFFICIAL_INBOUND'
  | 'META_OFFICIAL_STATUS_SENT'
  | 'META_OFFICIAL_STATUS_DELIVERED'
  | 'META_OFFICIAL_STATUS_READ'
  | 'META_OFFICIAL_STATUS_FAILED'
  | 'RCS_SYNTHETIC_REGRESSION';

interface SimulatorOutput {
  provider: ChannelProvider;
  channel: 'WHATSAPP' | 'RCS';
  eventType: GatewayAuditEvent['eventType'];
  result: GatewayAuditEvent['outcome'];
  reason: GatewayAuditEvent['reasonCode'];
  duplicate: boolean;
  correlationId: string;
}

function parseArguments(args: readonly string[]): SimulatorArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new GatewayError('INVALID_EVENT');
    }
    values.set(key.slice(2), value);
  }

  const provider = values.get('provider') as ChannelProvider | undefined;
  const fixture = values.get('fixture');
  const scenario = values.get('scenario') as SimulatorScenario | undefined;
  const repeatValue = values.get('repeat') ?? '1';
  const repeat = Number(repeatValue);
  if (
    (!scenario && (!provider || !fixture)) ||
    (provider !== undefined && !['WHATSAPP_META_OFFICIAL', 'WHATSAPP_EVOLUTION_OPTIONAL', 'RCS_GOOGLE'].includes(provider)) ||
    (scenario !== undefined && ![
      'META_VALID_SYNTHETIC',
      'META_DUPLICATE',
      'META_INVALID',
      'META_AUTH_REJECTED',
      'META_LIVE_NOT_CONFIGURED',
      'META_OFFICIAL_INBOUND',
      'META_OFFICIAL_STATUS_SENT',
      'META_OFFICIAL_STATUS_DELIVERED',
      'META_OFFICIAL_STATUS_READ',
      'META_OFFICIAL_STATUS_FAILED',
      'RCS_SYNTHETIC_REGRESSION'
    ].includes(scenario)) ||
    !Number.isInteger(repeat) ||
    repeat < 1 ||
    repeat > 10
  ) {
    throw new GatewayError('INVALID_EVENT');
  }
  return { provider, fixture, repeat, scenario };
}

function adapterFor(provider: ChannelProvider): ChannelGatewayAdapter {
  if (provider === 'WHATSAPP_META_OFFICIAL') {
    return new WhatsAppMetaOfflineAdapter({
      capabilities: ['TEXT', 'DELIVERY_RECEIPT'],
      capabilitySource: 'MANUAL'
    });
  }
  if (provider === 'RCS_GOOGLE') {
    return new RcsGoogleOfflineAdapter({
      capabilities: ['TEXT', 'RICH_MEDIA', 'DELIVERY_RECEIPT', 'READ_RECEIPT'],
      capabilitySource: 'MANUAL'
    });
  }
  return new EvolutionOptionalOfflineAdapter({
    capabilities: ['TEXT'],
    capabilitySource: 'MANUAL'
  });
}

export function loadSyntheticFixture(fixtureName: string): unknown {
  if (
    path.basename(fixtureName) !== fixtureName ||
    path.extname(fixtureName).toLowerCase() !== '.json'
  ) {
    throw new GatewayError('INVALID_EVENT');
  }
  const resolved = path.resolve(FIXTURE_DIRECTORY, fixtureName);
  if (path.dirname(resolved) !== FIXTURE_DIRECTORY) {
    throw new GatewayError('INVALID_EVENT');
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
}

export function simulateFixture(
  adapter: ChannelGatewayAdapter,
  rawFixture: unknown,
  repeat: number
): readonly GatewayAuditEvent[] {
  const store = new InMemoryDurableIdempotencyStore();
  const audits: GatewayAuditEvent[] = [];
  for (let index = 0; index < repeat; index += 1) {
    const result = processTrustedSyntheticFixture({
      adapter,
      rawFixture,
      trustMode: 'TRUSTED_SYNTHETIC_FIXTURE',
      idempotencyStore: store,
      ownerId: `simulator-owner-${index + 1}`,
      now: new Date(),
      leaseDurationMs: 30_000
    });
    audits.push(result.audit);
  }
  return audits;
}

class ScenarioAuthenticator implements WebhookAuthenticator {
  readonly provider = 'WHATSAPP_META_OFFICIAL' as const;
  readonly status = 'CONFIGURED' as const;

  constructor(private readonly resultStatus: Exclude<WebhookAuthenticationStatus, 'NOT_CONFIGURED'>) {}

  verify(request: RawWebhookRequest): WebhookAuthenticationResult {
    return {
      status: this.resultStatus,
      reasonCode: this.resultStatus === 'VERIFIED' ? 'SYNTHETIC_TEST_VERIFIED' : 'SYNTHETIC_TEST_REJECTED',
      provider: this.provider,
      requestId: request.requestId,
      evaluatedAt: new Date(request.receivedAt.getTime())
    };
  }
}

function liveScenario(authenticator: WebhookAuthenticator): GatewayAuditEvent {
  const now = new Date();
  return processLiveWebhookRequest({
    adapter: new WhatsAppMetaOfflineAdapter(),
    request: createLiveWebhookRequest({
      method: 'POST',
      rawBody: new TextEncoder().encode('{}'),
      receivedAt: now,
      requestId: 'simulator-live-request-opaque'
    }),
    authenticator,
    liveDecoder: new WhatsAppMetaLiveDecoderPending(),
    contactIdentityResolver: { resolve: () => ({ status: 'REJECTED', reasonCode: 'SIMULATOR_NO_RESOLUTION' }) },
    conversationResolver: { resolve: () => ({ status: 'REJECTED', reasonCode: 'SIMULATOR_NO_RESOLUTION' }) },
    idempotencyStore: new InMemoryDurableIdempotencyStore(),
    ownerId: 'simulator-live-owner-opaque',
    now,
    leaseDurationMs: 30_000
  }).audit;
}

function liveOfficialScenario(fixtureName: string): GatewayAuditEvent {
  const now = new Date();
  const resolved = path.resolve(FIXTURE_DIRECTORY, fixtureName);
  if (path.basename(fixtureName) !== fixtureName || path.dirname(resolved) !== FIXTURE_DIRECTORY) {
    throw new GatewayError('INVALID_EVENT');
  }

  return processLiveWebhookRequest({
    adapter: new WhatsAppMetaOfflineAdapter(),
    request: createLiveWebhookRequest({
      method: 'POST',
      rawBody: fs.readFileSync(resolved),
      receivedAt: now,
      requestId: 'simulator-official-request-opaque'
    }),
    authenticator: new ScenarioAuthenticator('VERIFIED'),
    liveDecoder: new WhatsAppMetaOfficialWebhookDecoder(),
    contactIdentityResolver: {
      resolve: () => ({
        status: 'RESOLVED_EXISTING',
        contactId: 'simulator-contact-opaque',
        contactIdentityId: 'simulator-identity-opaque'
      })
    },
    conversationResolver: {
      resolve: () => ({ status: 'RESOLVED_EXISTING', conversationId: 'simulator-conversation-opaque' })
    },
    idempotencyStore: new InMemoryDurableIdempotencyStore(),
    ownerId: 'simulator-official-owner-opaque',
    now,
    leaseDurationMs: 30_000
  }).audit;
}

function simulateScenario(scenario: SimulatorScenario): readonly GatewayAuditEvent[] {
  switch (scenario) {
    case 'META_VALID_SYNTHETIC':
      return simulateFixture(
        new WhatsAppMetaOfflineAdapter(),
        loadSyntheticFixture('whatsapp-inbound-text.json'),
        1
      );
    case 'META_DUPLICATE':
      return simulateFixture(
        new WhatsAppMetaOfflineAdapter(),
        loadSyntheticFixture('whatsapp-inbound-text.json'),
        2
      );
    case 'META_INVALID':
      return simulateFixture(new WhatsAppMetaOfflineAdapter(), { synthetic: true }, 1);
    case 'META_AUTH_REJECTED':
      return [liveScenario(new ScenarioAuthenticator('REJECTED'))];
    case 'META_LIVE_NOT_CONFIGURED':
      return [liveScenario(new UnconfiguredWebhookAuthenticator())];
    case 'META_OFFICIAL_INBOUND':
      return [liveOfficialScenario('meta-official-inbound-envelope.synthetic.json')];
    case 'META_OFFICIAL_STATUS_SENT':
      return [liveOfficialScenario('meta-official-status-sent.synthetic.json')];
    case 'META_OFFICIAL_STATUS_DELIVERED':
      return [liveOfficialScenario('meta-official-status-delivered.synthetic.json')];
    case 'META_OFFICIAL_STATUS_READ':
      return [liveOfficialScenario('meta-official-status-read.synthetic.json')];
    case 'META_OFFICIAL_STATUS_FAILED':
      return [liveOfficialScenario('meta-official-status-failed.synthetic.json')];
    case 'RCS_SYNTHETIC_REGRESSION':
      return simulateFixture(
        new RcsGoogleOfflineAdapter(),
        loadSyntheticFixture('rcs-inbound-text.json'),
        1
      );
  }
}

function toSimulatorOutput(audit: GatewayAuditEvent): SimulatorOutput {
  return {
    provider: audit.provider,
    channel: audit.channel,
    eventType: audit.eventType,
    result: audit.outcome,
    reason: audit.reasonCode,
    duplicate: audit.duplicate,
    correlationId: audit.internalEventId
  };
}

export function executeGatewaySimulatorCli(
  args: readonly string[],
  write: (line: string) => void = console.log
): number {
  try {
    const parsed = parseArguments(args);
    const audits = parsed.scenario
      ? simulateScenario(parsed.scenario)
      : simulateFixture(adapterFor(parsed.provider!), loadSyntheticFixture(parsed.fixture!), parsed.repeat);
    for (const audit of audits) {
      write(JSON.stringify(toSimulatorOutput(audit)));
    }
    return audits.every((audit) => audit.outcome !== 'REJECTED') ? 0 : 1;
  } catch (error) {
    const code = error instanceof GatewayError ? error.code : 'INVALID_EVENT';
    write(`FAIL ${code}`);
    return 1;
  }
}

const isDirectExecution = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectExecution) {
  process.exitCode = executeGatewaySimulatorCli(process.argv.slice(2));
}
