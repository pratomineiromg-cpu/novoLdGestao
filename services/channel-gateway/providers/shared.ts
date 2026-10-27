import { createProviderCapabilities } from '../../../src/domain/omnichannel';
import type {
  ChannelProvider,
  CommunicationChannel,
  MessageOriginSurface,
  ProviderCapabilities
} from '../../../src/domain/omnichannel';
import type {
  GatewayAdapterConfiguration,
  GatewayEventType,
  GatewayNormalizationContext,
  NormalizedChannelEvent,
  NormalizedChannelPayload
} from '../contracts';
import {
  optionalString,
  requiredOccurredAt,
  SyntheticFixtureRecord
} from '../normalization';

export function configuredCapabilities(
  provider: ChannelProvider,
  channel: CommunicationChannel,
  configuration: GatewayAdapterConfiguration,
  observedAt: Date
): ProviderCapabilities {
  return createProviderCapabilities({
    provider,
    channel,
    capabilities: configuration.capabilities ?? [],
    observedAt: new Date(observedAt.getTime()),
    source: configuration.capabilitySource ?? 'UNKNOWN'
  });
}

export function normalizedFixtureEvent(
  record: SyntheticFixtureRecord,
  context: GatewayNormalizationContext,
  provider: ChannelProvider,
  channel: CommunicationChannel,
  eventType: GatewayEventType,
  payload: NormalizedChannelPayload,
  originSurface?: MessageOriginSurface
): NormalizedChannelEvent {
  return {
    internalEventId: context.createInternalEventId(),
    provider,
    channel,
    providerEventId: optionalString(record, 'providerEventId'),
    providerMessageId: optionalString(record, 'providerMessageId'),
    occurredAt: requiredOccurredAt(record),
    eventType,
    originSurface,
    payload
  };
}
