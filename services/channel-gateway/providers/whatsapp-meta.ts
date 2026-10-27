import type { ProviderCapabilities } from '../../../src/domain/omnichannel';
import type {
  ChannelGatewayAdapter,
  GatewayAdapterConfiguration,
  GatewayNormalizationContext,
  NormalizedChannelEvent,
  OutboundPreparationInput,
  PreparedOutboundMessage
} from '../contracts';
import type { ProviderRawDecoder, RawWebhookRequest } from '../rawWebhook';
import { GatewayError } from '../errors';
import {
  createProviderIdempotencyKey,
  optionalContentType,
  optionalString,
  prepareProviderNeutralOutbound,
  requiredString
} from '../normalization';
import { configuredCapabilities, normalizedFixtureEvent } from './shared';
import { decodeMetaSyntheticFixture } from './metaSyntheticFixture';

export class WhatsAppMetaOfflineAdapter implements ChannelGatewayAdapter {
  readonly provider = 'WHATSAPP_META_OFFICIAL' as const;
  readonly channel = 'WHATSAPP' as const;

  constructor(private readonly configuration: GatewayAdapterConfiguration = {}) {}

  getCapabilities(observedAt: Date): ProviderCapabilities {
    return configuredCapabilities(this.provider, this.channel, this.configuration, observedAt);
  }

  normalizeEvent(
    rawFixture: unknown,
    context: GatewayNormalizationContext
  ): NormalizedChannelEvent {
    const record = decodeMetaSyntheticFixture(rawFixture);
    const kind = requiredString(record, 'kind');

    if (kind === 'inbound_message') {
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

    if (kind === 'delivery_status') {
      const deliveryStatus = requiredString(record, 'deliveryStatus');
      if (!['SENT', 'DELIVERED', 'FAILED'].includes(deliveryStatus)) {
        throw new GatewayError('INVALID_EVENT');
      }
      return normalizedFixtureEvent(
        record,
        context,
        this.provider,
        this.channel,
        'DELIVERY_STATUS',
        { deliveryStatus: deliveryStatus as 'SENT' | 'DELIVERED' | 'FAILED' },
        'PROVIDER'
      );
    }

    if (kind === 'outbound_message_observed') {
      return normalizedFixtureEvent(
        record,
        context,
        this.provider,
        this.channel,
        'OUTBOUND_MESSAGE_OBSERVED',
        {
          externalConversationId: optionalString(record, 'externalConversationId'),
          content: {
            contentType: optionalContentType(record),
            text: requiredString(record, 'text')
          }
        },
        'WHATSAPP_BUSINESS_APP'
      );
    }

    throw new GatewayError('UNSUPPORTED_EVENT');
  }

  createIdempotencyKey(event: NormalizedChannelEvent): string {
    return createProviderIdempotencyKey(event);
  }

  prepareOutbound(input: OutboundPreparationInput): PreparedOutboundMessage {
    return prepareProviderNeutralOutbound(this.provider, this.channel, input);
  }
}

/** PENDING OFFICIAL SPEC VERIFICATION: live Meta decoding is deliberately unavailable. */
export class WhatsAppMetaLiveDecoderPending implements ProviderRawDecoder {
  readonly provider = 'WHATSAPP_META_OFFICIAL' as const;

  decode(
    _request: RawWebhookRequest,
    _context: GatewayNormalizationContext
  ): NormalizedChannelEvent {
    throw new GatewayError('OFFICIAL_PROTOCOL_NOT_VERIFIED');
  }
}
