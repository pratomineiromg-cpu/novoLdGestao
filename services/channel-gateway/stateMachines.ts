export type InboundProcessingState =
  | 'RECEIVED'
  | 'AUTH_PENDING'
  | 'AUTHENTICATED'
  | 'VALIDATED'
  | 'IDEMPOTENCY_ACQUIRED'
  | 'NORMALIZED'
  | 'IDENTITY_RESOLUTION_PENDING'
  | 'CONVERSATION_RESOLUTION_PENDING'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'DUPLICATE'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL';

const INBOUND_TRANSITIONS: Readonly<Record<InboundProcessingState, readonly InboundProcessingState[]>> = {
  RECEIVED: ['AUTH_PENDING', 'VALIDATED', 'REJECTED'],
  AUTH_PENDING: ['AUTHENTICATED', 'REJECTED'],
  AUTHENTICATED: ['VALIDATED', 'REJECTED'],
  VALIDATED: ['IDEMPOTENCY_ACQUIRED', 'REJECTED'],
  IDEMPOTENCY_ACQUIRED: ['NORMALIZED', 'DUPLICATE', 'FAILED_RETRYABLE', 'FAILED_FINAL'],
  NORMALIZED: ['IDENTITY_RESOLUTION_PENDING', 'ACCEPTED', 'REJECTED'],
  IDENTITY_RESOLUTION_PENDING: ['CONVERSATION_RESOLUTION_PENDING', 'REJECTED'],
  CONVERSATION_RESOLUTION_PENDING: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: [],
  REJECTED: [],
  DUPLICATE: [],
  FAILED_RETRYABLE: [],
  FAILED_FINAL: []
};

export function transitionInboundState(
  current: InboundProcessingState,
  next: InboundProcessingState
): InboundProcessingState {
  if (!INBOUND_TRANSITIONS[current].includes(next)) {
    throw new Error(`INVALID_INBOUND_TRANSITION:${current}->${next}`);
  }
  return next;
}

export type OutboundProcessingState =
  | 'PREPARED'
  | 'QUEUED'
  | 'RESERVED'
  | 'SENDING'
  | 'PROVIDER_ACCEPTED'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL'
  | 'CANCELLED';

const OUTBOUND_TRANSITIONS: Readonly<Record<OutboundProcessingState, readonly OutboundProcessingState[]>> = {
  PREPARED: ['QUEUED', 'CANCELLED'],
  QUEUED: ['RESERVED', 'CANCELLED'],
  RESERVED: ['SENDING', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED'],
  SENDING: ['PROVIDER_ACCEPTED', 'FAILED_RETRYABLE', 'FAILED_FINAL'],
  PROVIDER_ACCEPTED: ['DELIVERED', 'FAILED_RETRYABLE', 'FAILED_FINAL'],
  DELIVERED: ['READ'],
  READ: [],
  FAILED_RETRYABLE: ['QUEUED', 'FAILED_FINAL', 'CANCELLED'],
  FAILED_FINAL: [],
  CANCELLED: []
};

export function transitionOutboundState(
  current: OutboundProcessingState,
  next: OutboundProcessingState
): OutboundProcessingState {
  if (!OUTBOUND_TRANSITIONS[current].includes(next)) {
    throw new Error(`INVALID_OUTBOUND_TRANSITION:${current}->${next}`);
  }
  return next;
}
