import type {
  CapabilitySource,
  ChannelAvailability,
  ChannelCapability,
  ChannelProvider,
  CommunicationChannel,
  MessageContentType,
  MessageOriginSurface,
  ProviderCapabilities,
  RoutingDecision
} from '../../src/domain/omnichannel';

export type GatewayEventType =
  | 'INBOUND_MESSAGE'
  | 'OUTBOUND_MESSAGE_OBSERVED'
  | 'DELIVERY_STATUS'
  | 'READ_STATUS'
  | 'CAPABILITY_UPDATE'
  | 'SUBSCRIPTION_UPDATE'
  | 'PROVIDER_STATUS';

export type GatewayOutcome = 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';

export const GATEWAY_ERROR_CODES = [
  'INVALID_EVENT',
  'MALFORMED_REQUEST',
  'WEBHOOK_AUTH_NOT_CONFIGURED',
  'WEBHOOK_AUTH_REJECTED',
  'OFFICIAL_PROTOCOL_NOT_VERIFIED',
  'IDENTITY_NOT_FOUND',
  'IDENTITY_AMBIGUOUS',
  'IDENTITY_REJECTED',
  'CONVERSATION_NOT_FOUND',
  'CONVERSATION_AMBIGUOUS',
  'CONVERSATION_REJECTED',
  'UNSUPPORTED_EVENT',
  'DUPLICATE_EVENT',
  'PROVIDER_UNAVAILABLE',
  'AUTH_REQUIRED',
  'RATE_LIMITED',
  'NON_RETRYABLE',
  'UNKNOWN_PROVIDER_ERROR'
] as const;

export type GatewayErrorCode = typeof GATEWAY_ERROR_CODES[number];

export function isGatewayErrorCode(value: unknown): value is GatewayErrorCode {
  return typeof value === 'string' && (GATEWAY_ERROR_CODES as readonly string[]).includes(value);
}

export type GatewayRetryability = 'RETRYABLE' | 'NON_RETRYABLE';

/** Provider-neutral content held in memory. It is never an audit/log payload. */
export interface ProviderNeutralContent {
  contentType: MessageContentType;
  text?: string;
}

/**
 * Minimal normalized payload. External addresses and message content are
 * transient sensitive data and must only cross an explicitly authorized
 * downstream resolution boundary.
 */
export interface NormalizedChannelPayload {
  content?: ProviderNeutralContent;
  providerAddress?: string;
  externalConversationId?: string;
  providerTimestamp?: string;
  deliveryStatus?: 'SENT' | 'DELIVERED' | 'FAILED';
  readStatus?: 'READ';
  availability?: ChannelAvailability;
  capabilities?: readonly ChannelCapability[];
  capabilitySource?: CapabilitySource;
  subscriptionStatus?: 'SUBSCRIBED' | 'UNSUBSCRIBED';
  providerStatus?: 'AVAILABLE' | 'UNAVAILABLE' | 'DEGRADED';
}

export interface NormalizedChannelEvent {
  internalEventId: string;
  provider: ChannelProvider;
  channel: CommunicationChannel;
  providerEventId?: string;
  providerMessageId?: string;
  occurredAt: Date;
  eventType: GatewayEventType;
  originSurface?: MessageOriginSurface;
  payload: NormalizedChannelPayload;
}

export interface GatewayAdapterConfiguration {
  capabilities?: readonly ChannelCapability[];
  capabilitySource?: CapabilitySource;
}

export interface GatewayNormalizationContext {
  createInternalEventId: () => string;
}

export interface OutboundPreparationInput {
  internalMessageId: string;
  contactId: string;
  contactIdentityId: string;
  content: ProviderNeutralContent;
  correlationId: string;
  routingDecision: RoutingDecision;
  routingDecisionId?: string;
}

/** Prepared only. No transport, endpoint, token, or delivery claim exists here. */
export interface PreparedOutboundMessage {
  internalMessageId: string;
  contactId: string;
  contactIdentityId: string;
  channel: CommunicationChannel;
  provider: ChannelProvider;
  content: ProviderNeutralContent;
  correlationId: string;
  routingDecisionId?: string;
  state: 'PREPARED';
}

export interface ChannelGatewayAdapter {
  readonly provider: ChannelProvider;
  readonly channel: CommunicationChannel;
  getCapabilities(observedAt: Date): ProviderCapabilities;
  normalizeEvent(rawFixture: unknown, context: GatewayNormalizationContext): NormalizedChannelEvent;
  createIdempotencyKey(event: NormalizedChannelEvent): string;
  prepareOutbound(input: OutboundPreparationInput): PreparedOutboundMessage;
}

export type GatewayCommand =
  | { type: 'InboundMessageReceived'; event: NormalizedChannelEvent }
  | { type: 'OutboundMessageObserved'; event: NormalizedChannelEvent }
  | { type: 'MessageDeliveryUpdated'; event: NormalizedChannelEvent }
  | { type: 'MessageReadUpdated'; event: NormalizedChannelEvent }
  | { type: 'ChannelCapabilityUpdated'; event: NormalizedChannelEvent }
  | { type: 'ChannelSubscriptionUpdated'; event: NormalizedChannelEvent }
  | { type: 'ProviderStatusObserved'; event: NormalizedChannelEvent };

/** Deliberately excludes raw payloads and all customer/provider addresses. */
export interface GatewayAuditEvent {
  internalEventId: string;
  provider: ChannelProvider;
  channel: CommunicationChannel;
  eventType: GatewayEventType | 'UNCLASSIFIED';
  outcome: GatewayOutcome;
  reasonCode: GatewayErrorCode | 'EVENT_ACCEPTED';
  occurredAt: string;
  auditedAt: string;
  retryCount: number;
  duplicate: boolean;
}

export type GatewayProcessResult =
  | {
      outcome: 'ACCEPTED';
      event: NormalizedChannelEvent;
      command: GatewayCommand;
      audit: GatewayAuditEvent;
    }
  | {
      outcome: 'DUPLICATE';
      event: NormalizedChannelEvent;
      audit: GatewayAuditEvent;
    }
  | {
      outcome: 'REJECTED';
      audit: GatewayAuditEvent;
    };

export interface SourceCoordinates {
  entryIndex: number;
  changeIndex: number;
  itemIndex: number;
}

export interface DecodedProviderBatchItem {
  itemId: string;
  providerEventId?: string;
  providerMessageId?: string;
  rawEventKind: 'message' | 'status' | 'unsupported_event';
  sourceCoordinates?: SourceCoordinates;
  event?: NormalizedChannelEvent;
  providerTimestamp?: string;
  errorReason?: GatewayErrorCode | string;
}

export interface DecodedProviderBatch {
  requestId: string;
  provider: ChannelProvider;
  channel: CommunicationChannel;
  batchId: string;
  receivedAt: Date;
  decodedAt: Date;
  items: readonly DecodedProviderBatchItem[];
}

export interface ProviderBatchDecoder {
  readonly provider: ChannelProvider;
  decodeBatch(
    rawRequest: unknown,
    context: GatewayNormalizationContext
  ): DecodedProviderBatch;
}
