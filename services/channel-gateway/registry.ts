import type {
  ChannelGatewayAdapter,
  OutboundPreparationInput,
  PreparedOutboundMessage
} from './contracts';
import { GatewayError } from './errors';

/** Selects only the provider/channel already chosen by the domain decision. */
export function adapterForRoutingDecision(
  adapters: readonly ChannelGatewayAdapter[],
  input: OutboundPreparationInput
): ChannelGatewayAdapter {
  const { selectedChannel, selectedProvider } = input.routingDecision;
  if (!selectedChannel || !selectedProvider) {
    throw new GatewayError('PROVIDER_UNAVAILABLE');
  }
  const adapter = adapters.find(
    (candidate) =>
      candidate.channel === selectedChannel && candidate.provider === selectedProvider
  );
  if (!adapter) {
    throw new GatewayError('PROVIDER_UNAVAILABLE');
  }
  return adapter;
}

export function prepareOutboundFromRouting(
  adapters: readonly ChannelGatewayAdapter[],
  input: OutboundPreparationInput
): PreparedOutboundMessage {
  return adapterForRoutingDecision(adapters, input).prepareOutbound(input);
}
