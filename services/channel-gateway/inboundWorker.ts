import { createGatewayCommand } from './command';
import { isGatewayErrorCode, type GatewayCommand, type GatewayErrorCode, type NormalizedChannelEvent } from './contracts';
import { GatewayError } from './errors';
import type { InboundWorkItem, InboundWorkQueue } from './ingress';
import {
  createGatewayOperationalEvent,
  emitGatewayOperationalEventSafely,
  type GatewayOperationalEventSink,
  type GatewayOperationalReasonCode,
  type GatewayOperationalStage
} from './operability';
import {
  mayContinueAfterConversationResolution,
  mayContinueAfterIdentityResolution,
  type ContactIdentityResolver,
  type ConversationResolver
} from './resolution';
import type { RetryPolicyInput } from './retryPolicy';

export interface InboundWorkReferenceResolvers {
  contactIdentityResolver: ContactIdentityResolver;
  conversationResolver: ConversationResolver;
}

/** Opaque references only. A NEW_CONVERSATION is created by the injected resolver, never by the kernel. */
export interface ResolvedInboundWorkReferences {
  contactId: string;
  contactIdentityId: string;
  conversationId: string;
  conversationCreated?: true;
}

export type ReferenceResolutionOutcome =
  | { status: 'RESOLVED'; references: ResolvedInboundWorkReferences | undefined }
  | { status: 'RETRYABLE_FAILURE'; reasonCode: GatewayErrorCode }
  | { status: 'FINAL_FAILURE'; reasonCode: GatewayErrorCode };

export interface ReferenceResolutionContext {
  creationIdempotencyKey?: string;
  observe?: (event: {
    stage: 'IDENTITY_RESOLUTION' | 'CONVERSATION_RESOLUTION';
    outcome: 'SUCCESS' | 'FAILURE';
    reasonCode: GatewayOperationalReasonCode;
  }) => void;
}

function observeResolution(
  context: ReferenceResolutionContext,
  event: Parameters<NonNullable<ReferenceResolutionContext['observe']>>[0]
): void {
  try {
    context.observe?.(event);
  } catch {
    // Resolution must not depend on a runtime observability exporter.
  }
}

/**
 * Resolves only inbound-message references after work has been leased. Status
 * and provider-state commands do not require CRM identity resolution.
 */
export function resolveInboundWorkReferences(
  event: NormalizedChannelEvent,
  dependencies: InboundWorkReferenceResolvers,
  context: ReferenceResolutionContext = {}
): ReferenceResolutionOutcome {
  if (event.eventType !== 'INBOUND_MESSAGE') {
    return { status: 'RESOLVED', references: undefined };
  }

  const externalAddress = event.payload.providerAddress;
  if (!externalAddress) {
    observeResolution(context, {
      stage: 'IDENTITY_RESOLUTION', outcome: 'FAILURE', reasonCode: 'IDENTITY_REJECTED'
    });
    return { status: 'FINAL_FAILURE', reasonCode: 'IDENTITY_REJECTED' };
  }

  const identity = dependencies.contactIdentityResolver.resolve({
    provider: event.provider,
    channel: event.channel,
    externalAddress
  });
  if (!mayContinueAfterIdentityResolution(identity)) {
    if (identity.status === 'NOT_FOUND') {
      observeResolution(context, {
        stage: 'IDENTITY_RESOLUTION', outcome: 'FAILURE', reasonCode: 'IDENTITY_NOT_FOUND'
      });
      return { status: 'RETRYABLE_FAILURE', reasonCode: 'IDENTITY_NOT_FOUND' };
    }
    if (identity.status === 'AMBIGUOUS') {
      observeResolution(context, {
        stage: 'IDENTITY_RESOLUTION', outcome: 'FAILURE', reasonCode: 'IDENTITY_AMBIGUOUS'
      });
      return { status: 'RETRYABLE_FAILURE', reasonCode: 'IDENTITY_AMBIGUOUS' };
    }
    if (identity.status === 'RETRYABLE_FAILURE') {
      observeResolution(context, {
        stage: 'IDENTITY_RESOLUTION', outcome: 'FAILURE', reasonCode: identity.reasonCode
      });
      return { status: 'RETRYABLE_FAILURE', reasonCode: identity.reasonCode };
    }
    if (identity.status === 'FINAL_FAILURE') {
      observeResolution(context, {
        stage: 'IDENTITY_RESOLUTION', outcome: 'FAILURE', reasonCode: identity.reasonCode
      });
      return { status: 'FINAL_FAILURE', reasonCode: identity.reasonCode };
    }
    observeResolution(context, {
      stage: 'IDENTITY_RESOLUTION', outcome: 'FAILURE', reasonCode: 'IDENTITY_REJECTED'
    });
    return { status: 'FINAL_FAILURE', reasonCode: 'IDENTITY_REJECTED' };
  }
  observeResolution(context, {
    stage: 'IDENTITY_RESOLUTION', outcome: 'SUCCESS', reasonCode: 'OPERATION_COMPLETED'
  });

  const conversation = dependencies.conversationResolver.resolve({
    contactId: identity.contactId,
    provider: event.provider,
    channel: event.channel,
    externalConversationId: event.payload.externalConversationId,
    creationIdempotencyKey: context.creationIdempotencyKey
  });
  if (!mayContinueAfterConversationResolution(conversation)) {
    if (conversation.status === 'NOT_FOUND') {
      observeResolution(context, {
        stage: 'CONVERSATION_RESOLUTION', outcome: 'FAILURE', reasonCode: 'CONVERSATION_NOT_FOUND'
      });
      return { status: 'RETRYABLE_FAILURE', reasonCode: 'CONVERSATION_NOT_FOUND' };
    }
    if (conversation.status === 'AMBIGUOUS') {
      observeResolution(context, {
        stage: 'CONVERSATION_RESOLUTION', outcome: 'FAILURE', reasonCode: 'CONVERSATION_AMBIGUOUS'
      });
      return { status: 'RETRYABLE_FAILURE', reasonCode: 'CONVERSATION_AMBIGUOUS' };
    }
    if (conversation.status === 'RETRYABLE_FAILURE') {
      observeResolution(context, {
        stage: 'CONVERSATION_RESOLUTION', outcome: 'FAILURE', reasonCode: conversation.reasonCode
      });
      return { status: 'RETRYABLE_FAILURE', reasonCode: conversation.reasonCode };
    }
    if (conversation.status === 'FINAL_FAILURE') {
      observeResolution(context, {
        stage: 'CONVERSATION_RESOLUTION', outcome: 'FAILURE', reasonCode: conversation.reasonCode
      });
      return { status: 'FINAL_FAILURE', reasonCode: conversation.reasonCode };
    }
    observeResolution(context, {
      stage: 'CONVERSATION_RESOLUTION', outcome: 'FAILURE', reasonCode: 'CONVERSATION_REJECTED'
    });
    return { status: 'FINAL_FAILURE', reasonCode: 'CONVERSATION_REJECTED' };
  }

  if (conversation.status === 'NEW_CONVERSATION' && !context.creationIdempotencyKey) {
    observeResolution(context, {
      stage: 'CONVERSATION_RESOLUTION', outcome: 'FAILURE', reasonCode: 'CONVERSATION_REJECTED'
    });
    return { status: 'FINAL_FAILURE', reasonCode: 'CONVERSATION_REJECTED' };
  }
  observeResolution(context, {
    stage: 'CONVERSATION_RESOLUTION', outcome: 'SUCCESS', reasonCode: 'OPERATION_COMPLETED'
  });

  return {
    status: 'RESOLVED',
    references: {
      contactId: identity.contactId,
      contactIdentityId: identity.contactIdentityId,
      conversationId: conversation.conversationId,
      ...(conversation.status === 'NEW_CONVERSATION' ? { conversationCreated: true as const } : {})
    }
  };
}

/**
 * The handler is an injected downstream boundary. The gateway supplies no
 * implementation, so this module cannot write CRM data or call a provider.
 */
export interface InboundCommandHandler {
  handle(execution: InboundCommandExecution): InboundCommandHandlingResult;
}

/** Sensitive command data stays in-process and is never returned by worker results. */
export interface InboundCommandExecution {
  workItemId: string;
  idempotencyKey: string;
  attempt: number;
  command: GatewayCommand;
  resolvedReferences?: ResolvedInboundWorkReferences;
}

export type InboundCommandHandlingResult =
  | { status: 'COMPLETED' }
  | { status: 'RETRYABLE_FAILURE'; reasonCode: GatewayErrorCode }
  | { status: 'FINAL_FAILURE'; reasonCode: GatewayErrorCode };

export interface InboundWorkerStepInput extends InboundWorkReferenceResolvers {
  queue: InboundWorkQueue;
  commandHandler: InboundCommandHandler;
  ownerId: string;
  now: Date;
  leaseDurationMs: number;
  retryPolicy: Omit<RetryPolicyInput, 'attempt' | 'retryability'>;
  operationalEventSink?: GatewayOperationalEventSink;
}

export type InboundWorkerStepStatus =
  | 'COMPLETED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL'
  | 'NOT_AVAILABLE'
  | 'ACKNOWLEDGMENT_UNCONFIRMED'
  | 'STATE_TRANSITION_UNCONFIRMED';

export type InboundWorkerReasonCode =
  | GatewayErrorCode
  | 'EVENT_ACCEPTED'
  | 'WORK_NOT_AVAILABLE'
  | 'COMMAND_HANDLER_FAILED'
  | 'ACKNOWLEDGMENT_UNCONFIRMED'
  | 'STATE_TRANSITION_UNCONFIRMED';

/** Safe, payload-free result for one deterministic worker claim/processing step. */
export interface InboundWorkerStepResult {
  status: InboundWorkerStepStatus;
  reasonCode: InboundWorkerReasonCode;
  workItemId?: string;
  commandType?: GatewayCommand['type'];
}

function assertValidWorkerInput(input: InboundWorkerStepInput): void {
  const { retryPolicy } = input;
  if (
    input.ownerId.trim().length === 0 ||
    Number.isNaN(input.now.getTime()) ||
    !Number.isFinite(input.leaseDurationMs) ||
    input.leaseDurationMs <= 0 ||
    !Number.isInteger(retryPolicy.maxAttempts) ||
    retryPolicy.maxAttempts < 1 ||
    !Number.isFinite(retryPolicy.baseDelayMs) ||
    retryPolicy.baseDelayMs < 0 ||
    !Number.isFinite(retryPolicy.maxDelayMs) ||
    retryPolicy.maxDelayMs < 0
  ) {
    throw new Error('INVALID_INBOUND_WORKER_INPUT');
  }
}

function validHandlerResult(result: unknown): result is InboundCommandHandlingResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const candidate = result as { status?: unknown; reasonCode?: unknown };
  if (candidate.status === 'COMPLETED') return true;
  return (
    (candidate.status === 'RETRYABLE_FAILURE' || candidate.status === 'FINAL_FAILURE') &&
    isGatewayErrorCode(candidate.reasonCode)
  );
}

function observeWorker(
  workItem: InboundWorkItem,
  input: InboundWorkerStepInput,
  stage: GatewayOperationalStage,
  outcome: 'SUCCESS' | 'FAILURE',
  reasonCode: GatewayOperationalReasonCode,
  options: { duplicate?: boolean; healthImpact?: 'NONE' | 'DEGRADED' | 'UNHEALTHY' } = {}
): void {
  emitGatewayOperationalEventSafely(
    input.operationalEventSink,
    createGatewayOperationalEvent({
      provider: workItem.event.provider,
      channel: workItem.event.channel,
      stage,
      outcome,
      reasonCode,
      retryCount: Math.max(0, workItem.attempt - 1),
      duplicate: options.duplicate ?? false,
      correlationId: workItem.workItemId,
      timestamp: input.now.toISOString(),
      ...(options.healthImpact ? { healthImpact: options.healthImpact } : {})
    })
  );
}

function failureResult(
  workItem: InboundWorkItem,
  input: InboundWorkerStepInput,
  reasonCode: InboundWorkerReasonCode
): InboundWorkerStepResult {
  try {
    const updated = input.queue.nack(
      workItem.workItemId,
      input.ownerId,
      input.now,
      reasonCode,
      input.retryPolicy
    );
    return {
      status: updated.state === 'FAILED_RETRYABLE' ? 'FAILED_RETRYABLE' : 'FAILED_FINAL',
      reasonCode,
      workItemId: workItem.workItemId
    };
  } catch {
    observeWorker(workItem, input, 'QUEUE', 'FAILURE', 'STATE_TRANSITION_UNCONFIRMED', {
      healthImpact: 'UNHEALTHY'
    });
    return {
      status: 'STATE_TRANSITION_UNCONFIRMED',
      reasonCode: 'STATE_TRANSITION_UNCONFIRMED',
      workItemId: workItem.workItemId
    };
  }
}

function finalFailureResult(
  workItem: InboundWorkItem,
  input: InboundWorkerStepInput,
  reasonCode: GatewayErrorCode
): InboundWorkerStepResult {
  try {
    input.queue.failFinal(workItem.workItemId, input.ownerId, input.now, reasonCode);
    return { status: 'FAILED_FINAL', reasonCode, workItemId: workItem.workItemId };
  } catch {
    observeWorker(workItem, input, 'QUEUE', 'FAILURE', 'STATE_TRANSITION_UNCONFIRMED', {
      healthImpact: 'UNHEALTHY'
    });
    return {
      status: 'STATE_TRANSITION_UNCONFIRMED',
      reasonCode: 'STATE_TRANSITION_UNCONFIRMED',
      workItemId: workItem.workItemId
    };
  }
}

function processReservedWorkItem(
  workItem: InboundWorkItem,
  input: InboundWorkerStepInput
): InboundWorkerStepResult {
  let command: GatewayCommand;
  try {
    const resolution = resolveInboundWorkReferences(workItem.event, input, {
      creationIdempotencyKey: workItem.idempotencyKey,
      observe: (event) => observeWorker(
        workItem,
        input,
        event.stage,
        event.outcome,
        event.reasonCode
      )
    });
    if (resolution.status === 'RETRYABLE_FAILURE') {
      return failureResult(workItem, input, resolution.reasonCode);
    }
    if (resolution.status === 'FINAL_FAILURE') {
      return finalFailureResult(workItem, input, resolution.reasonCode);
    }
    const resolvedReferences = resolution.references;
    command = createGatewayCommand(workItem.event);
    const handling = input.commandHandler.handle({
      workItemId: workItem.workItemId,
      idempotencyKey: workItem.idempotencyKey,
      attempt: workItem.attempt,
      command,
      ...(resolvedReferences ? { resolvedReferences } : {})
    });
    if (!validHandlerResult(handling)) throw new Error('INVALID_COMMAND_HANDLER_RESULT');

    if (handling.status === 'RETRYABLE_FAILURE') {
      observeWorker(workItem, input, 'COMMAND_HANDLING', 'FAILURE', handling.reasonCode);
      return failureResult(workItem, input, handling.reasonCode);
    }
    if (handling.status === 'FINAL_FAILURE') {
      observeWorker(workItem, input, 'COMMAND_HANDLING', 'FAILURE', handling.reasonCode);
      return finalFailureResult(workItem, input, handling.reasonCode);
    }
    observeWorker(workItem, input, 'COMMAND_HANDLING', 'SUCCESS', 'OPERATION_COMPLETED');
  } catch (error) {
    const reasonCode = error instanceof GatewayError ? error.code : 'COMMAND_HANDLER_FAILED';
    observeWorker(workItem, input, 'COMMAND_HANDLING', 'FAILURE', reasonCode);
    return failureResult(
      workItem,
      input,
      reasonCode
    );
  }

  try {
    input.queue.ack(workItem.workItemId, input.ownerId, input.now);
    observeWorker(workItem, input, 'ACKNOWLEDGMENT', 'SUCCESS', 'EVENT_ACCEPTED');
    return {
      status: 'COMPLETED',
      reasonCode: 'EVENT_ACCEPTED',
      workItemId: workItem.workItemId,
      commandType: command.type
    };
  } catch {
    // A real adapter may be uncertain after a crash at the acknowledgement boundary.
    // The injected handler receives the idempotency key so it can tolerate replay.
    observeWorker(workItem, input, 'ACKNOWLEDGMENT', 'FAILURE', 'ACKNOWLEDGMENT_UNCONFIRMED', {
      healthImpact: 'UNHEALTHY'
    });
    return {
      status: 'ACKNOWLEDGMENT_UNCONFIRMED',
      reasonCode: 'ACKNOWLEDGMENT_UNCONFIRMED',
      workItemId: workItem.workItemId,
      commandType: command.type
    };
  }
}

/**
 * Executes at most one atomically claimed work item. It has no timer, loop,
 * network client, persistence implementation, or provider-specific behavior.
 */
export function dispatchNextInboundWorkItem(input: InboundWorkerStepInput): InboundWorkerStepResult {
  assertValidWorkerInput(input);
  const reserved = input.queue.reserveNext({
    ownerId: input.ownerId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs
  });
  if (reserved.status !== 'RESERVED') {
    return { status: 'NOT_AVAILABLE', reasonCode: 'WORK_NOT_AVAILABLE' };
  }
  observeWorker(reserved.record, input, 'QUEUE', 'SUCCESS', 'OPERATION_COMPLETED');
  return processReservedWorkItem(reserved.record, input);
}
