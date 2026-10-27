import type { GatewayCommand, NormalizedChannelEvent } from './contracts';

/** Provider-neutral mapping retained at the gateway command boundary. */
export function createGatewayCommand(event: NormalizedChannelEvent): GatewayCommand {
  switch (event.eventType) {
    case 'INBOUND_MESSAGE':
      return { type: 'InboundMessageReceived', event };
    case 'OUTBOUND_MESSAGE_OBSERVED':
      return { type: 'OutboundMessageObserved', event };
    case 'DELIVERY_STATUS':
      return { type: 'MessageDeliveryUpdated', event };
    case 'READ_STATUS':
      return { type: 'MessageReadUpdated', event };
    case 'CAPABILITY_UPDATE':
      return { type: 'ChannelCapabilityUpdated', event };
    case 'SUBSCRIPTION_UPDATE':
      return { type: 'ChannelSubscriptionUpdated', event };
    case 'PROVIDER_STATUS':
      return { type: 'ProviderStatusObserved', event };
  }
}
