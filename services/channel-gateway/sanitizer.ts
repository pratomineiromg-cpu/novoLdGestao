import type {
  ChannelProvider,
  CommunicationChannel
} from '../../src/domain/omnichannel';
import type {
  GatewayAuditEvent,
  GatewayErrorCode,
  GatewayEventType,
  GatewayOutcome,
  NormalizedChannelEvent
} from './contracts';

interface AuditInput {
  event?: NormalizedChannelEvent;
  internalEventId: string;
  provider: ChannelProvider;
  channel: CommunicationChannel;
  eventType?: GatewayEventType;
  outcome: GatewayOutcome;
  reasonCode: GatewayErrorCode | 'EVENT_ACCEPTED';
  duplicate: boolean;
  retryCount?: number;
  auditedAt: Date;
}

/** This is the only simulator/log representation of a processed event. */
export function createSanitizedAuditEvent(input: AuditInput): GatewayAuditEvent {
  return {
    internalEventId: input.internalEventId,
    provider: input.provider,
    channel: input.channel,
    eventType: input.event?.eventType ?? input.eventType ?? 'UNCLASSIFIED',
    outcome: input.outcome,
    reasonCode: input.reasonCode,
    occurredAt: (input.event?.occurredAt ?? input.auditedAt).toISOString(),
    auditedAt: input.auditedAt.toISOString(),
    retryCount: input.retryCount ?? 0,
    duplicate: input.duplicate
  };
}
