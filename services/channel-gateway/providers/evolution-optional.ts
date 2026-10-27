import type { ProviderCapabilities } from '../../../src/domain/omnichannel';
import type {
  ChannelGatewayAdapter,
  GatewayAdapterConfiguration,
  GatewayNormalizationContext,
  NormalizedChannelEvent,
  OutboundPreparationInput,
  PreparedOutboundMessage
} from '../contracts';
import { GatewayError } from '../errors';
import {
  createProviderIdempotencyKey,
  optionalContentType,
  optionalString,
  prepareProviderNeutralOutbound,
  requiredString,
  requireSyntheticFixture
} from '../normalization';
import { configuredCapabilities, normalizedFixtureEvent } from './shared';

/** Optional substitution proof only; no session, transport, or provider default. */
export class EvolutionOptionalOfflineAdapter implements ChannelGatewayAdapter {
  readonly provider = 'WHATSAPP_EVOLUTION_OPTIONAL' as const;
  readonly channel = 'WHATSAPP' as const;

  constructor(private readonly configuration: GatewayAdapterConfiguration = {}) {}

  getCapabilities(observedAt: Date): ProviderCapabilities {
    return configuredCapabilities(this.provider, this.channel, this.configuration, observedAt);
  }

  normalizeEvent(
    rawFixture: unknown,
    context: GatewayNormalizationContext
  ): NormalizedChannelEvent {
    const record = requireSyntheticFixture(rawFixture);
    if (requiredString(record, 'kind') !== 'inbound_message') {
      throw new GatewayError('UNSUPPORTED_EVENT');
    }
    return normalizedFixtureEvent(
      record,
      context,
      this.provider,
      this.channel,
      'INBOUND_MESSAGE',
      {
        providerAddress: requiredString(record, 'providerAddress'),
        externalConversationId: optionalString(record, 'externalConversationId'),
        content: {
          contentType: optionalContentType(record),
          text: requiredString(record, 'text')
        }
      },
      'CUSTOMER'
    );
  }

  createIdempotencyKey(event: NormalizedChannelEvent): string {
    return createProviderIdempotencyKey(event);
  }

  prepareOutbound(input: OutboundPreparationInput): PreparedOutboundMessage {
    return prepareProviderNeutralOutbound(this.provider, this.channel, input);
  }
}
