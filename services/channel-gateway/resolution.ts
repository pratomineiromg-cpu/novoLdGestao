import type { ChannelProvider, CommunicationChannel } from '../../src/domain/omnichannel';
import type { GatewayErrorCode } from './contracts';

export interface ContactIdentityResolutionRequest {
  provider: ChannelProvider;
  channel: CommunicationChannel;
  /** Transient PII: never log, persist, or use as an internal/idempotency ID here. */
  externalAddress: string;
  providerIdentityId?: string;
}

export type ContactIdentityResolutionResult =
  | { status: 'RESOLVED'; contactId: string; contactIdentityId: string }
  /** @deprecated F1B-12 compatibility alias. New resolvers should return RESOLVED. */
  | { status: 'RESOLVED_EXISTING'; contactId: string; contactIdentityId: string }
  | { status: 'NOT_FOUND' }
  | { status: 'AMBIGUOUS' }
  | { status: 'INVALID'; reasonCode?: string }
  | { status: 'RETRYABLE_FAILURE'; reasonCode: GatewayErrorCode }
  | { status: 'FINAL_FAILURE'; reasonCode: GatewayErrorCode }
  /** @deprecated F1B-12 compatibility alias. New resolvers should return INVALID or FINAL_FAILURE. */
  | { status: 'REJECTED'; reasonCode: string };

export interface ContactIdentityResolver {
  resolve(request: ContactIdentityResolutionRequest): ContactIdentityResolutionResult;
}

export interface ConversationResolutionRequest {
  contactId: string;
  provider: ChannelProvider;
  channel: CommunicationChannel;
  externalConversationId?: string;
  /** Required by a resolver before it may create and return NEW_CONVERSATION. */
  creationIdempotencyKey?: string;
}

export type ConversationResolutionResult =
  | { status: 'EXISTING_CONVERSATION'; conversationId: string }
  | { status: 'NEW_CONVERSATION'; conversationId: string }
  /** @deprecated F1B-12 compatibility alias. New resolvers should return EXISTING_CONVERSATION. */
  | { status: 'RESOLVED_EXISTING'; conversationId: string }
  /** @deprecated F1B-12 compatibility result retained for callers not yet migrated. */
  | { status: 'NOT_FOUND' }
  | { status: 'AMBIGUOUS' }
  | { status: 'RETRYABLE_FAILURE'; reasonCode: GatewayErrorCode }
  | { status: 'FINAL_FAILURE'; reasonCode: GatewayErrorCode }
  /** @deprecated F1B-12 compatibility alias. New resolvers should return FINAL_FAILURE. */
  | { status: 'REJECTED'; reasonCode: string };

export interface ConversationResolver {
  resolve(request: ConversationResolutionRequest): ConversationResolutionResult;
}

export function mayContinueAfterIdentityResolution(
  result: ContactIdentityResolutionResult
): result is Extract<ContactIdentityResolutionResult, { status: 'RESOLVED' | 'RESOLVED_EXISTING' }> {
  return result.status === 'RESOLVED' || result.status === 'RESOLVED_EXISTING';
}

export function mayContinueAfterConversationResolution(
  result: ConversationResolutionResult
): result is Extract<
  ConversationResolutionResult,
  { status: 'EXISTING_CONVERSATION' | 'NEW_CONVERSATION' | 'RESOLVED_EXISTING' }
> {
  return (
    result.status === 'EXISTING_CONVERSATION' ||
    result.status === 'NEW_CONVERSATION' ||
    result.status === 'RESOLVED_EXISTING'
  );
}
