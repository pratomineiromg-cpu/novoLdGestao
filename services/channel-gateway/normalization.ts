import { randomUUID } from 'node:crypto';
import type {
  ChannelCapability,
  ChannelProvider,
  CommunicationChannel,
  MessageContentType
} from '../../src/domain/omnichannel';
import type {
  GatewayEventType,
  NormalizedChannelEvent,
  OutboundPreparationInput,
  PreparedOutboundMessage
} from './contracts';
import { GatewayError } from './errors';

const CONTENT_TYPES: readonly MessageContentType[] = [
  'TEXT',
  'IMAGE',
  'AUDIO',
  'DOCUMENT',
  'SYSTEM',
  'RICH_CONTENT'
];

const CHANNEL_CAPABILITIES: readonly ChannelCapability[] = [
  'TEXT',
  'IMAGE',
  'DOCUMENT',
  'AUDIO',
  'TEMPLATE',
  'RICH_MEDIA',
  'DELIVERY_RECEIPT',
  'READ_RECEIPT',
  'MESSAGE_ECHO',
  'CONTACT_SYNC',
  'PRESENCE',
  'CATALOG'
];

export type SyntheticFixtureRecord = Record<string, unknown> & { synthetic: true };

export function createOpaqueGatewayId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function requireSyntheticFixture(input: unknown): SyntheticFixtureRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GatewayError('INVALID_EVENT');
  }
  const record = input as Record<string, unknown>;
  if (record.synthetic !== true) {
    throw new GatewayError('INVALID_EVENT');
  }
  return record as SyntheticFixtureRecord;
}

export function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayError('INVALID_EVENT');
  }
  return value.trim();
}

export function optionalString(
  record: Record<string, unknown>,
  field: string
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayError('INVALID_EVENT');
  }
  return value.trim();
}

export function requiredOccurredAt(record: Record<string, unknown>): Date {
  const value = requiredString(record, 'occurredAt');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new GatewayError('INVALID_EVENT');
  }
  return parsed;
}

export function optionalContentType(
  record: Record<string, unknown>,
  fallback: MessageContentType = 'TEXT'
): MessageContentType {
  const value = record.contentType;
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !CONTENT_TYPES.includes(value as MessageContentType)) {
    throw new GatewayError('INVALID_EVENT');
  }
  return value as MessageContentType;
}

export function requiredCapabilities(record: Record<string, unknown>): readonly ChannelCapability[] {
  const value = record.capabilities;
  if (!Array.isArray(value)) {
    throw new GatewayError('INVALID_EVENT');
  }
  const capabilities = value.map((item) => {
    if (typeof item !== 'string' || !CHANNEL_CAPABILITIES.includes(item as ChannelCapability)) {
      throw new GatewayError('INVALID_EVENT');
    }
    return item as ChannelCapability;
  });
  return [...new Set(capabilities)];
}

const MESSAGE_EVENT_TYPES: readonly GatewayEventType[] = [
  'INBOUND_MESSAGE',
  'OUTBOUND_MESSAGE_OBSERVED',
  'DELIVERY_STATUS',
  'READ_STATUS'
];

function lengthPrefixed(value: string): string {
  return `${value.length}:${value}`;
}

/** Provider IDs only; customer address, name, and message content are never inputs. */
export function createProviderIdempotencyKey(event: NormalizedChannelEvent): string {
  const providerPrefix = lengthPrefixed(event.provider);
  if (event.providerEventId) {
    return `${providerPrefix}:event:${lengthPrefixed(event.providerEventId)}`;
  }
  if (MESSAGE_EVENT_TYPES.includes(event.eventType) && event.providerMessageId) {
    return `${providerPrefix}:message:${lengthPrefixed(event.providerMessageId)}`;
  }
  throw new GatewayError('INVALID_EVENT');
}

export function assertNormalizedEvent(event: NormalizedChannelEvent): void {
  if (
    !event.internalEventId ||
    !event.provider ||
    !event.channel ||
    Number.isNaN(event.occurredAt.getTime())
  ) {
    throw new GatewayError('INVALID_EVENT');
  }
  createProviderIdempotencyKey(event);
}

export function prepareProviderNeutralOutbound(
  provider: ChannelProvider,
  channel: CommunicationChannel,
  input: OutboundPreparationInput
): PreparedOutboundMessage {
  const decision = input.routingDecision;
  if (
    decision.contactId !== input.contactId ||
    decision.selectedChannel !== channel ||
    decision.selectedProvider !== provider
  ) {
    throw new GatewayError('INVALID_EVENT');
  }
  if (
    input.internalMessageId.trim().length === 0 ||
    input.contactIdentityId.trim().length === 0 ||
    input.correlationId.trim().length === 0 ||
    input.content.contentType.trim().length === 0
  ) {
    throw new GatewayError('INVALID_EVENT');
  }
  return {
    internalMessageId: input.internalMessageId,
    contactId: input.contactId,
    contactIdentityId: input.contactIdentityId,
    channel,
    provider,
    content: { ...input.content },
    correlationId: input.correlationId,
    routingDecisionId: input.routingDecisionId,
    state: 'PREPARED'
  };
}
