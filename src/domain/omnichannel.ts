/**
 * Offline omnichannel domain contracts.
 *
 * This module intentionally has no SDK, transport, credential, or network
 * dependency. Live channel adapters must stay outside the core domain.
 */

export type CommunicationChannel = 'WHATSAPP' | 'RCS';

/** `NONE` is meaningful for an Order, but is not a communication channel. */
export type OrderChannel = CommunicationChannel | 'NONE';

export type ChannelProvider =
  | 'WHATSAPP_META_OFFICIAL'
  | 'WHATSAPP_EVOLUTION_OPTIONAL'
  | 'RCS_GOOGLE';

export function isChannelProviderCompatible(
  channel: CommunicationChannel,
  provider: ChannelProvider
): boolean {
  if (channel === 'RCS') {
    return provider === 'RCS_GOOGLE';
  }
  return provider === 'WHATSAPP_META_OFFICIAL' || provider === 'WHATSAPP_EVOLUTION_OPTIONAL';
}

export type ChannelAvailability =
  | 'UNKNOWN'
  | 'KNOWN_AVAILABLE'
  | 'KNOWN_UNAVAILABLE';

export type CapabilitySource =
  | 'WHATSAPP_SYNC'
  | 'RCS_CAPABILITY_CHECK'
  | 'PROVIDER_EVENT'
  | 'DELIVERY_RESULT'
  | 'IMPORT'
  | 'MANUAL'
  | 'UNKNOWN';

export type ChannelEligibility = 'UNKNOWN' | 'ELIGIBLE' | 'INELIGIBLE';

/** Metadata only; it does not encode a legal or commercial eligibility rule. */
export type EligibilitySource =
  | 'POLICY'
  | 'PROVIDER'
  | 'CONSENT'
  | 'CONFIGURATION'
  | 'MANUAL'
  | 'UNKNOWN';

export interface ContactChannelIdentity {
  /** Opaque LidacomZap-controlled technical ID; never derive it from an address. */
  id: string;
  tenantId: string;
  contactId: string;
  channel: CommunicationChannel;
  provider?: ChannelProvider;
  /** Already normalized by the source-specific ingress boundary. */
  address: string;
  availability: ChannelAvailability;
  availabilitySource: CapabilitySource;
  eligibility: ChannelEligibility;
  eligibilitySource?: EligibilitySource;
  providerIdentityId?: string;
  lastCapabilityCheckAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateContactChannelIdentityInput {
  id: string;
  tenantId: string;
  contactId: string;
  channel: CommunicationChannel;
  provider?: ChannelProvider;
  address: string;
  availability?: ChannelAvailability;
  availabilitySource?: CapabilitySource;
  eligibility?: ChannelEligibility;
  eligibilitySource?: EligibilitySource;
  providerIdentityId?: string;
  lastCapabilityCheckAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Creates an identity with conservative defaults. UNKNOWN is deliberately
 * preserved until an adapter or approved policy provides evidence.
 */
export function createContactChannelIdentity(
  input: CreateContactChannelIdentityInput
): ContactChannelIdentity {
  if (input.provider && !isChannelProviderCompatible(input.channel, input.provider)) {
    throw new Error(`Provider ${input.provider} is not compatible with channel ${input.channel}.`);
  }
  return {
    ...input,
    availability: input.availability ?? 'UNKNOWN',
    availabilitySource: input.availabilitySource ?? 'UNKNOWN',
    eligibility: input.eligibility ?? 'UNKNOWN'
  };
}

export type ChannelCapability =
  | 'TEXT'
  | 'IMAGE'
  | 'DOCUMENT'
  | 'AUDIO'
  | 'TEMPLATE'
  | 'RICH_MEDIA'
  | 'DELIVERY_RECEIPT'
  | 'READ_RECEIPT'
  | 'MESSAGE_ECHO'
  | 'CONTACT_SYNC'
  | 'PRESENCE'
  | 'CATALOG';

export interface ProviderCapabilities {
  channel: CommunicationChannel;
  provider: ChannelProvider;
  /** Only capabilities explicitly reported by a future adapter belong here. */
  capabilities: readonly ChannelCapability[];
  observedAt: Date;
  source: CapabilitySource;
}

export interface CreateProviderCapabilitiesInput {
  channel: CommunicationChannel;
  provider: ChannelProvider;
  capabilities?: readonly ChannelCapability[];
  observedAt: Date;
  source?: CapabilitySource;
}

/** An omitted capability record, or an omitted capability, is unavailable. */
export function createProviderCapabilities(
  input: CreateProviderCapabilitiesInput
): ProviderCapabilities {
  if (!isChannelProviderCompatible(input.channel, input.provider)) {
    throw new Error(`Provider ${input.provider} is not compatible with channel ${input.channel}.`);
  }
  return {
    ...input,
    capabilities: input.capabilities ?? [],
    source: input.source ?? 'UNKNOWN'
  };
}

export function hasKnownProviderCapability(
  providerCapabilities: ProviderCapabilities | undefined,
  capability: ChannelCapability
): boolean {
  return providerCapabilities?.capabilities.includes(capability) ?? false;
}

export type MessageOriginSurface =
  | 'PLATFORM'
  | 'WHATSAPP_BUSINESS_APP'
  | 'PROVIDER'
  | 'CUSTOMER';

export type MessageContentType =
  | 'TEXT'
  | 'IMAGE'
  | 'AUDIO'
  | 'DOCUMENT'
  | 'SYSTEM'
  | 'RICH_CONTENT';

export interface ExternalMessageReference {
  provider: ChannelProvider;
  providerMessageId: string;
}

/**
 * An internal idempotency key for externally delivered events. Length-prefixing
 * keeps the two key parts unambiguous without exposing either as a public token.
 */
export function externalMessageIdempotencyKey(reference: ExternalMessageReference): string {
  const providerMessageId = reference.providerMessageId.trim();
  if (providerMessageId.length === 0) {
    throw new Error('providerMessageId must be a non-empty string.');
  }
  return `${reference.provider.length}:${reference.provider}:${providerMessageId.length}:${providerMessageId}`;
}

export type ContactImportSource =
  | 'WHATSAPP_COEXISTENCE'
  | 'EXCEL'
  | 'CSV'
  | 'GOOGLE_CONTACTS';

export type ContactImportTechnicalReasonCode =
  | 'INVALID_RECORD'
  | 'DUPLICATE_CONTACT'
  | 'INVALID_CHANNEL_IDENTITY'
  | 'UNSUPPORTED_SOURCE_DATA';

/** Aggregate technical diagnostics only. No input address or customer field belongs here. */
export interface ContactImportTechnicalReason {
  code: ContactImportTechnicalReasonCode;
  count: number;
}

export interface ContactImportReport {
  operationId: string;
  importId: string;
  source: ContactImportSource;
  found: number;
  valid: number;
  rejected: number;
  duplicate: number;
  technicalReasons: readonly ContactImportTechnicalReason[];
  startedAt: Date;
  completedAt: Date;
}

export type RoutingMode = 'WHATSAPP' | 'RCS' | 'BOTH_SMART';

export type RoutingReason =
  | 'WHATSAPP_SELECTED'
  | 'RCS_SELECTED'
  | 'WHATSAPP_UNAVAILABLE_FALLBACK_RCS'
  | 'WHATSAPP_INELIGIBLE_FALLBACK_RCS'
  | 'NO_ELIGIBLE_CHANNEL'
  | 'REQUESTED_CHANNEL_UNAVAILABLE'
  | 'REQUESTED_CHANNEL_INELIGIBLE';

export interface RoutingDecision {
  contactId: string;
  requestedMode: RoutingMode;
  selectedChannel: CommunicationChannel | null;
  selectedProvider?: ChannelProvider;
  reason: RoutingReason;
  evaluatedAt: Date;
}
