import type { PreparedOutboundMessage } from './contracts';
import type { GatewayFailureCategory } from './errors';
import { calculateRetryDecision, type RetryPolicyInput } from './retryPolicy';
import { transitionOutboundState, type OutboundProcessingState } from './stateMachines';

export interface OutboundQueueRecord {
  queueId: string;
  message: PreparedOutboundMessage;
  state: OutboundProcessingState;
  attempt: number;
  enqueuedAt: Date;
  ownerId?: string;
  leaseExpiresAt?: Date;
  nextAttemptAt?: Date;
  failureCategory?: GatewayFailureCategory;
}

export type QueueEnqueueResult =
  | { status: 'ENQUEUED'; record: OutboundQueueRecord }
  | { status: 'DUPLICATE'; record: OutboundQueueRecord };

export type QueueReserveResult =
  | { status: 'RESERVED'; record: OutboundQueueRecord }
  | { status: 'NOT_AVAILABLE'; record?: OutboundQueueRecord };

export interface OutboundQueue {
  enqueue(queueId: string, message: PreparedOutboundMessage, now: Date): QueueEnqueueResult;
  reserve(queueId: string, ownerId: string, now: Date, leaseDurationMs: number): QueueReserveResult;
  ack(queueId: string, ownerId: string, deliveredAt: Date): OutboundQueueRecord;
  nack(
    queueId: string,
    ownerId: string,
    now: Date,
    category: GatewayFailureCategory,
    retryPolicy: Omit<RetryPolicyInput, 'attempt' | 'retryability'>,
    retryHintMs?: number
  ): OutboundQueueRecord;
  cancel(queueId: string): OutboundQueueRecord;
  get(queueId: string): OutboundQueueRecord | undefined;
}

function copyRecord(record: OutboundQueueRecord): OutboundQueueRecord {
  return {
    ...record,
    message: { ...record.message, content: { ...record.message.content } },
    enqueuedAt: new Date(record.enqueuedAt.getTime()),
    leaseExpiresAt: record.leaseExpiresAt && new Date(record.leaseExpiresAt.getTime()),
    nextAttemptAt: record.nextAttemptAt && new Date(record.nextAttemptAt.getTime())
  };
}

/** Process-local reference implementation; no timer, worker, transport, or persistence. */
export class InMemoryOutboundQueue implements OutboundQueue {
  private readonly records = new Map<string, OutboundQueueRecord>();
  private readonly messageIds = new Map<string, string>();
  private readonly correlationIds = new Map<string, string>();

  enqueue(queueId: string, message: PreparedOutboundMessage, now: Date): QueueEnqueueResult {
    if (message.state !== 'PREPARED' || queueId.trim().length === 0) {
      throw new Error('INVALID_QUEUE_MESSAGE');
    }
    const duplicateId = this.messageIds.get(message.internalMessageId) ??
      this.correlationIds.get(message.correlationId);
    if (duplicateId) {
      return { status: 'DUPLICATE', record: copyRecord(this.records.get(duplicateId)!) };
    }
    const record: OutboundQueueRecord = {
      queueId,
      message: { ...message, content: { ...message.content } },
      state: transitionOutboundState('PREPARED', 'QUEUED'),
      attempt: 0,
      enqueuedAt: new Date(now.getTime())
    };
    this.records.set(queueId, record);
    this.messageIds.set(message.internalMessageId, queueId);
    this.correlationIds.set(message.correlationId, queueId);
    return { status: 'ENQUEUED', record: copyRecord(record) };
  }

  reserve(queueId: string, ownerId: string, now: Date, leaseDurationMs: number): QueueReserveResult {
    const record = this.records.get(queueId);
    if (!record || ownerId.trim().length === 0 || leaseDurationMs <= 0) {
      return { status: 'NOT_AVAILABLE', record: record && copyRecord(record) };
    }
    const activeLease = record.state === 'RESERVED' && record.leaseExpiresAt &&
      record.leaseExpiresAt.getTime() > now.getTime();
    const retryWaiting = record.nextAttemptAt && record.nextAttemptAt.getTime() > now.getTime();
    if (activeLease || retryWaiting || !['QUEUED', 'RESERVED'].includes(record.state)) {
      return { status: 'NOT_AVAILABLE', record: copyRecord(record) };
    }
    record.state = record.state === 'QUEUED'
      ? transitionOutboundState('QUEUED', 'RESERVED')
      : 'RESERVED';
    record.ownerId = ownerId;
    record.leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
    record.nextAttemptAt = undefined;
    record.attempt += 1;
    return { status: 'RESERVED', record: copyRecord(record) };
  }

  ack(queueId: string, ownerId: string, _deliveredAt: Date): OutboundQueueRecord {
    const record = this.requireOwner(queueId, ownerId);
    record.state = transitionOutboundState('RESERVED', 'SENDING');
    record.state = transitionOutboundState('SENDING', 'PROVIDER_ACCEPTED');
    record.state = transitionOutboundState('PROVIDER_ACCEPTED', 'DELIVERED');
    record.ownerId = undefined;
    record.leaseExpiresAt = undefined;
    return copyRecord(record);
  }

  nack(
    queueId: string,
    ownerId: string,
    now: Date,
    category: GatewayFailureCategory,
    retryPolicy: Omit<RetryPolicyInput, 'attempt' | 'retryability'>,
    retryHintMs?: number
  ): OutboundQueueRecord {
    const record = this.requireOwner(queueId, ownerId);
    const retryable = ['RETRYABLE', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'UNKNOWN_PROVIDER_ERROR']
      .includes(category);
    const decision = calculateRetryDecision({
      ...retryPolicy,
      attempt: record.attempt,
      retryability: retryable ? 'RETRYABLE' : 'NON_RETRYABLE'
    });
    const failedState = decision.retry ? 'FAILED_RETRYABLE' : 'FAILED_FINAL';
    record.state = transitionOutboundState('RESERVED', failedState);
    record.failureCategory = category;
    record.ownerId = undefined;
    record.leaseExpiresAt = undefined;
    if (decision.retry) {
      const delayMs = Math.max(decision.delayMs ?? 0, retryHintMs ?? 0);
      record.nextAttemptAt = new Date(now.getTime() + delayMs);
      record.state = transitionOutboundState('FAILED_RETRYABLE', 'QUEUED');
    }
    return copyRecord(record);
  }

  cancel(queueId: string): OutboundQueueRecord {
    const record = this.requireRecord(queueId);
    record.state = transitionOutboundState(record.state, 'CANCELLED');
    record.ownerId = undefined;
    record.leaseExpiresAt = undefined;
    return copyRecord(record);
  }

  get(queueId: string): OutboundQueueRecord | undefined {
    const record = this.records.get(queueId);
    return record && copyRecord(record);
  }

  private requireRecord(queueId: string): OutboundQueueRecord {
    const record = this.records.get(queueId);
    if (!record) throw new Error('QUEUE_RECORD_NOT_FOUND');
    return record;
  }

  private requireOwner(queueId: string, ownerId: string): OutboundQueueRecord {
    const record = this.requireRecord(queueId);
    if (record.state !== 'RESERVED' || record.ownerId !== ownerId) {
      throw new Error('QUEUE_OWNER_MISMATCH');
    }
    return record;
  }
}
