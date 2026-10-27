import {
  CommunicationChannel,
  ContactChannelIdentity,
  RoutingDecision,
  RoutingMode,
  RoutingReason
} from './omnichannel';

export interface RoutingRequest {
  contactId: string;
  requestedMode: RoutingMode;
  identities: readonly ContactChannelIdentity[];
  /** Supplied by the caller so the function remains deterministic and pure. */
  evaluatedAt: Date;
}

function identitiesForChannel(
  request: RoutingRequest,
  channel: CommunicationChannel
): readonly ContactChannelIdentity[] {
  return request.identities.filter(
    (identity) => identity.contactId === request.contactId && identity.channel === channel
  );
}

function routeableIdentity(
  identities: readonly ContactChannelIdentity[]
): ContactChannelIdentity | undefined {
  return identities.find(
    (identity) =>
      identity.availability === 'KNOWN_AVAILABLE' && identity.eligibility === 'ELIGIBLE'
  );
}

function requestedChannelReason(
  identities: readonly ContactChannelIdentity[]
): RoutingReason {
  return identities.some((identity) => identity.availability === 'KNOWN_AVAILABLE')
    ? 'REQUESTED_CHANNEL_INELIGIBLE'
    : 'REQUESTED_CHANNEL_UNAVAILABLE';
}

function decision(
  request: RoutingRequest,
  selectedChannel: CommunicationChannel | null,
  selectedIdentity: ContactChannelIdentity | undefined,
  reason: RoutingReason
): RoutingDecision {
  return {
    contactId: request.contactId,
    requestedMode: request.requestedMode,
    selectedChannel,
    selectedProvider: selectedIdentity?.provider,
    reason,
    evaluatedAt: new Date(request.evaluatedAt.getTime())
  };
}

/**
 * Resolves one safe channel at most. It is intentionally data-only: no provider
 * calls, discovery probes, capability checks, sending, or mutable state.
 */
export function decideRouting(request: RoutingRequest): RoutingDecision {
  const whatsappIdentities = identitiesForChannel(request, 'WHATSAPP');
  const rcsIdentities = identitiesForChannel(request, 'RCS');
  const whatsapp = routeableIdentity(whatsappIdentities);
  const rcs = routeableIdentity(rcsIdentities);

  if (request.requestedMode === 'WHATSAPP') {
    return whatsapp
      ? decision(request, 'WHATSAPP', whatsapp, 'WHATSAPP_SELECTED')
      : decision(request, null, undefined, requestedChannelReason(whatsappIdentities));
  }

  if (request.requestedMode === 'RCS') {
    return rcs
      ? decision(request, 'RCS', rcs, 'RCS_SELECTED')
      : decision(request, null, undefined, requestedChannelReason(rcsIdentities));
  }

  if (whatsapp) {
    return decision(request, 'WHATSAPP', whatsapp, 'WHATSAPP_SELECTED');
  }

  if (rcs) {
    const reason = whatsappIdentities.some(
      (identity) => identity.availability === 'KNOWN_AVAILABLE'
    )
      ? 'WHATSAPP_INELIGIBLE_FALLBACK_RCS'
      : 'WHATSAPP_UNAVAILABLE_FALLBACK_RCS';
    return decision(request, 'RCS', rcs, reason);
  }

  return decision(request, null, undefined, 'NO_ELIGIBLE_CHANNEL');
}
