import type {
  CapabilitySource,
  ChannelAvailability,
  ProviderCapabilities
} from '../../../src/domain/omnichannel';
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
  requiredCapabilities,
  requiredString,
  requireSyntheticFixture
} from '../normalization';
import { configuredCapabilities, normalizedFixtureEvent } from './shared';

const CAPABILITY_SOURCES: readonly CapabilitySource[] = [
  'RCS_CAPABILITY_CHECK',
  'PROVIDER_EVENT',
  'DELIVERY_RESULT',
  'MANUAL',
  'UNKNOWN'
];

const AVAILABILITIES: readonly ChannelAvailability[] = [
  'UNKNOWN',
  'KNOWN_AVAILABLE',
  'KNOWN_UNAVAILABLE'
];

export class RcsGoogleOfflineAdapter implements ChannelGatewayAdapter {
  readonly provider = 'RCS_GOOGLE' as const;
  readonly channel = 'RCS' as const;

  constructor(private readonly configuration: GatewayAdapterConfiguration = {}) {}

  getCapabilities(observedAt: Date): ProviderCapabilities {
    return configuredCapabilities(this.provider, this.channel, this.configuration, observedAt);
  }

  normalizeEvent(
    rawFixture: unknown,
    context: GatewayNormalizationContext
  ): NormalizedChannelEvent {
    const record = requireSyntheticFixture(rawFixture);
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

    if (kind === 'read_status') {
      return normalizedFixtureEvent(
        record,
        context,
        this.provider,
        this.channel,
        'READ_STATUS',
        { readStatus: 'READ' },
        'PROVIDER'
      );
    }

    if (kind === 'capability_update') {
      const availability = requiredString(record, 'availability') as ChannelAvailability;
      const capabilitySource = requiredString(record, 'capabilitySource') as CapabilitySource;
      if (!AVAILABILITIES.includes(availability) || !CAPABILITY_SOURCES.includes(capabilitySource)) {
        throw new GatewayError('INVALID_EVENT');
      }
      return normalizedFixtureEvent(
        record,
        context,
        this.provider,
        this.channel,
        'CAPABILITY_UPDATE',
        {
          availability,
          capabilities: requiredCapabilities(record),
          capabilitySource
        },
        'PROVIDER'
      );
    }

    if (kind === 'subscription_update') {
      const subscriptionStatus = requiredString(record, 'subscriptionStatus');
      if (!['SUBSCRIBED', 'UNSUBSCRIBED'].includes(subscriptionStatus)) {
        throw new GatewayError('INVALID_EVENT');
      }
      return normalizedFixtureEvent(
        record,
        context,
        this.provider,
        this.channel,
        'SUBSCRIPTION_UPDATE',
        { subscriptionStatus: subscriptionStatus as 'SUBSCRIBED' | 'UNSUBSCRIBED' },
        'PROVIDER'
      );
    }

    if (kind === 'provider_status') {
      const providerStatus = requiredString(record, 'providerStatus');
      if (!['AVAILABLE', 'UNAVAILABLE', 'DEGRADED'].includes(providerStatus)) {
        throw new GatewayError('INVALID_EVENT');
      }
      return normalizedFixtureEvent(
        record,
        context,
        this.provider,
        this.channel,
        'PROVIDER_STATUS',
        { providerStatus: providerStatus as 'AVAILABLE' | 'UNAVAILABLE' | 'DEGRADED' },
        'PROVIDER'
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
