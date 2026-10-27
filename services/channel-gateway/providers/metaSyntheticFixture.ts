import type { SyntheticFixtureRecord } from '../normalization';
import { requiredString, requireSyntheticFixture } from '../normalization';
import { GatewayError } from '../errors';

export const META_SYNTHETIC_FIXTURE_CONTRACT = 'INTERNAL_SYNTHETIC_META_V1' as const;

/**
 * THIS IS AN INTERNAL SYNTHETIC FIXTURE CONTRACT.
 * IT IS NOT THE OFFICIAL META LIVE PAYLOAD SCHEMA.
 */
export interface MetaSyntheticFixture extends SyntheticFixtureRecord {
  fixtureContract: typeof META_SYNTHETIC_FIXTURE_CONTRACT;
  provider: 'WHATSAPP_META_OFFICIAL';
  channel: 'WHATSAPP';
  kind: 'inbound_message' | 'delivery_status' | 'outbound_message_observed';
}

export function decodeMetaSyntheticFixture(input: unknown): MetaSyntheticFixture {
  const record = requireSyntheticFixture(input);
  if (
    requiredString(record, 'fixtureContract') !== META_SYNTHETIC_FIXTURE_CONTRACT ||
    requiredString(record, 'provider') !== 'WHATSAPP_META_OFFICIAL' ||
    requiredString(record, 'channel') !== 'WHATSAPP'
  ) {
    throw new GatewayError('INVALID_EVENT');
  }
  const kind = requiredString(record, 'kind');
  if (!['inbound_message', 'delivery_status', 'outbound_message_observed'].includes(kind)) {
    throw new GatewayError('UNSUPPORTED_EVENT');
  }
  return record as MetaSyntheticFixture;
}
