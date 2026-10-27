import type { ChannelProvider } from '../../src/domain/omnichannel';
import type { SourceCoordinates, NormalizedChannelEvent } from './contracts';
import { calculateRetryDecision, type RetryPolicyInput } from './retryPolicy';

export type WebhookItemDisposition =
  | 'ADMITTED'
  | 'DUPLICATE'
  | 'ALREADY_PROCESSING'
  | 'FINAL_REJECTED'
  | 'UNSUPPORTED'
  | 'RETRYABLE_FAILURE';

export type WebhookAckDecision = 'ACKNOWLEDGE' | 'RETRY_REQUEST' | 'REJECT_REQUEST';

export type InboundAdmissionState =
  | 'ADMITTED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL';

export type InboundWorkState =
  | 'QUEUED'
  | 'RESERVED'
  | 'COMPLETED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL';

export interface InboundAdmissionRecord {
  idempotencyKey: string;
  provider: ChannelProvider;
  providerEventId?: string;
  workItemId: string;
  state: InboundAdmissionState;
  admittedAt: Date;
  updatedAt: Date;
}

/** Sensitive work payload boundary. Never serialize this record into HTTP/audit/metrics. */
export interface InboundWorkItem {
  workItemId: string;
  idempotencyKey: string;
  provider: ChannelProvider;
  providerEventId?: string;
  rawEventKind: 'message' | 'status';
  event: NormalizedChannelEvent;
  state: InboundWorkState;
  attempt: number;
  enqueuedAt: Date;
  ownerId?: string;
  leaseExpiresAt?: Date;
  nextAttemptAt?: Date;
  failureReasonCode?: string;
}

export interface AdmitInboundItemInput {
  idempotencyKey: string;
  workItemId: string;
  provider: ChannelProvider;
  providerEventId?: string;
  rawEventKind: 'message' | 'status';
  event: NormalizedChannelEvent;
  admittedAt: Date;
}

export interface AdmitInboundItemResult {
  disposition: Exclude<WebhookItemDisposition, 'UNSUPPORTED' | 'RETRYABLE_FAILURE'>;
  admission: InboundAdmissionRecord;
  workItem?: InboundWorkItem;
}

export interface WebhookBatchItemResult {
  itemId: string;
  providerEventId?: string;
  rawEventKind: 'message' | 'status' | 'unsupported_event';
  sourceCoordinates?: SourceCoordinates;
  disposition: WebhookItemDisposition;
  reasonCode: string;
  workItemId?: string;
}

export interface WebhookBatchResult {
  requestId: string;
  batchId: string;
  provider: ChannelProvider;
  receivedAt: Date;
  totalItemCount: number;
  admittedCount: number;
  duplicateCount: number;
  alreadyProcessingCount: number;
  finalRejectedCount: number;
  unsupportedCount: number;
  retryableFailureCount: number;
  items: readonly WebhookBatchItemResult[];
}

export interface DurableIngressBatchRecord extends WebhookBatchResult {
  ingressBatchId: string;
  correlationId: string;
}

export interface RecordIngressBatchInput {
  ingressBatchId: string;
  correlationId: string;
  result: WebhookBatchResult;
}

export interface InboundAdmissionStore {
  /**
   * Conceptual atomic boundary: dedupe/admission record and queued work become
   * visible together, or neither becomes visible.
   */
  admit(input: AdmitInboundItemInput): AdmitInboundItemResult;
  getAdmission(idempotencyKey: string): InboundAdmissionRecord | undefined;
  recordBatch(input: RecordIngressBatchInput): DurableIngressBatchRecord;
  getBatch(ingressBatchId: string): DurableIngressBatchRecord | undefined;
}

export type InboundQueueEnqueueResult =
  | { status: 'ENQUEUED'; record: InboundWorkItem }
  | { status: 'DUPLICATE'; record: InboundWorkItem };

export type InboundQueueReserveResult =
  | { status: 'RESERVED'; record: InboundWorkItem }
  | { status: 'NOT_AVAILABLE'; record?: InboundWorkItem };

/**
 * One atomic worker-claim attempt. A durable adapter must select and reserve
 * the work item in the same persistence boundary; it must not expose a
 * list-then-reserve race to its caller.
 */
export interface InboundQueueReserveNextInput {
  ownerId: string;
  now: Date;
  leaseDurationMs: number;
}

export interface InboundWorkQueue {
  enqueue(item: InboundWorkItem): InboundQueueEnqueueResult;
  reserve(workItemId: string, ownerId: string, now: Date, leaseDurationMs: number): InboundQueueReserveResult;
  reserveNext(input: InboundQueueReserveNextInput): InboundQueueReserveResult;
  ack(workItemId: string, ownerId: string, completedAt: Date): InboundWorkItem;
  nack(
    workItemId: string,
    ownerId: string,
    now: Date,
    reasonCode: string,
    retryPolicy: Omit<RetryPolicyInput, 'attempt' | 'retryability'>
  ): InboundWorkItem;
  failFinal(workItemId: string, ownerId: string, now: Date, reasonCode: string): InboundWorkItem;
  get(workItemId: string): InboundWorkItem | undefined;
  list(state?: InboundWorkState): readonly InboundWorkItem[];
}

/** Compatibility name retained for the F1B-10 branch while the contract is hardened. */
export interface DurableWebhookIngressStore extends InboundAdmissionStore, InboundWorkQueue {}

interface InMemoryIngressState {
  admissions: Map<string, InboundAdmissionRecord>;
  workItems: Map<string, InboundWorkItem>;
  batches: Map<string, DurableIngressBatchRecord>;
}

function cloneEvent(event: NormalizedChannelEvent): NormalizedChannelEvent {
  return {
    ...event,
    occurredAt: new Date(event.occurredAt.getTime()),
    payload: {
      ...event.payload,
      ...(event.payload.content ? { content: { ...event.payload.content } } : {}),
      ...(event.payload.capabilities ? { capabilities: [...event.payload.capabilities] } : {})
    }
  };
}

function copyAdmission(record: InboundAdmissionRecord): InboundAdmissionRecord {
  return {
    ...record,
    admittedAt: new Date(record.admittedAt.getTime()),
    updatedAt: new Date(record.updatedAt.getTime())
  };
}

function copyWorkItem(record: InboundWorkItem): InboundWorkItem {
  return {
    ...record,
    event: cloneEvent(record.event),
    enqueuedAt: new Date(record.enqueuedAt.getTime()),
    leaseExpiresAt: record.leaseExpiresAt && new Date(record.leaseExpiresAt.getTime()),
    nextAttemptAt: record.nextAttemptAt && new Date(record.nextAttemptAt.getTime())
  };
}

function isReservableWorkItem(record: InboundWorkItem, now: Date): boolean {
  if (record.state === 'QUEUED') return true;
  if (record.state === 'RESERVED') {
    return !record.leaseExpiresAt || record.leaseExpiresAt.getTime() <= now.getTime();
  }
  if (record.state === 'FAILED_RETRYABLE') {
    return !record.nextAttemptAt || record.nextAttemptAt.getTime() <= now.getTime();
  }
  return false;
}

function availableAt(record: InboundWorkItem): number {
  if (record.state === 'RESERVED') return record.leaseExpiresAt?.getTime() ?? record.enqueuedAt.getTime();
  if (record.state === 'FAILED_RETRYABLE') return record.nextAttemptAt?.getTime() ?? record.enqueuedAt.getTime();
  return record.enqueuedAt.getTime();
}

function copyBatchItem(item: WebhookBatchItemResult): WebhookBatchItemResult {
  return {
    ...item,
    ...(item.sourceCoordinates ? { sourceCoordinates: { ...item.sourceCoordinates } } : {})
  };
}

function copyBatchResult<T extends WebhookBatchResult>(record: T): T {
  return {
    ...record,
    receivedAt: new Date(record.receivedAt.getTime()),
    items: record.items.map(copyBatchItem)
  };
}

function dispositionForExisting(record: InboundAdmissionRecord): AdmitInboundItemResult['disposition'] {
  switch (record.state) {
    case 'PROCESSING':
      return 'ALREADY_PROCESSING';
    case 'FAILED_FINAL':
      return 'FINAL_REJECTED';
    case 'ADMITTED':
    case 'COMPLETED':
    case 'FAILED_RETRYABLE':
      return 'DUPLICATE';
  }
}

/**
 * Process-local reference only. It models the atomicity contract by publishing
 * new admission + queued-work maps with one state assignment. It is NOT
 * production durable storage and performs no I/O.
 */
export class InMemoryDurableWebhookIngressStore implements DurableWebhookIngressStore {
  private state: InMemoryIngressState = {
    admissions: new Map(),
    workItems: new Map(),
    batches: new Map()
  };

  admit(input: AdmitInboundItemInput): AdmitInboundItemResult {
    if (
      input.idempotencyKey.trim().length === 0 ||
      input.workItemId.trim().length === 0 ||
      Number.isNaN(input.admittedAt.getTime())
    ) {
      throw new Error('INVALID_INBOUND_ADMISSION_INPUT');
    }

    const existing = this.state.admissions.get(input.idempotencyKey);
    if (existing) {
      const work = this.state.workItems.get(existing.workItemId);
      return {
        disposition: dispositionForExisting(existing),
        admission: copyAdmission(existing),
        ...(work ? { workItem: copyWorkItem(work) } : {})
      };
    }

    if (this.state.workItems.has(input.workItemId)) {
      throw new Error('WORK_ITEM_ID_COLLISION');
    }

    const admission: InboundAdmissionRecord = {
      idempotencyKey: input.idempotencyKey,
      provider: input.provider,
      providerEventId: input.providerEventId,
      workItemId: input.workItemId,
      state: 'ADMITTED',
      admittedAt: new Date(input.admittedAt.getTime()),
      updatedAt: new Date(input.admittedAt.getTime())
    };
    const workItem: InboundWorkItem = {
      workItemId: input.workItemId,
      idempotencyKey: input.idempotencyKey,
      provider: input.provider,
      providerEventId: input.providerEventId,
      rawEventKind: input.rawEventKind,
      event: cloneEvent(input.event),
      state: 'QUEUED',
      attempt: 0,
      enqueuedAt: new Date(input.admittedAt.getTime())
    };

    const admissions = new Map(this.state.admissions);
    const workItems = new Map(this.state.workItems);
    admissions.set(input.idempotencyKey, admission);
    workItems.set(input.workItemId, workItem);

    // Conceptual commit point: admission and work staging become visible together.
    this.state = { ...this.state, admissions, workItems };

    return {
      disposition: 'ADMITTED',
      admission: copyAdmission(admission),
      workItem: copyWorkItem(workItem)
    };
  }

  getAdmission(idempotencyKey: string): InboundAdmissionRecord | undefined {
    const record = this.state.admissions.get(idempotencyKey);
    return record && copyAdmission(record);
  }

  recordBatch(input: RecordIngressBatchInput): DurableIngressBatchRecord {
    if (input.ingressBatchId.trim().length === 0 || input.correlationId.trim().length === 0) {
      throw new Error('INVALID_INGRESS_BATCH_INPUT');
    }
    const record: DurableIngressBatchRecord = {
      ...copyBatchResult(input.result),
      ingressBatchId: input.ingressBatchId,
      correlationId: input.correlationId
    };
    const batches = new Map(this.state.batches);
    batches.set(input.ingressBatchId, record);
    this.state = { ...this.state, batches };
    return copyBatchResult(record);
  }

  getBatch(ingressBatchId: string): DurableIngressBatchRecord | undefined {
    const record = this.state.batches.get(ingressBatchId);
    return record && copyBatchResult(record);
  }

  enqueue(item: InboundWorkItem): InboundQueueEnqueueResult {
    const existing = this.state.workItems.get(item.workItemId);
    if (existing) return { status: 'DUPLICATE', record: copyWorkItem(existing) };
    const admission = this.state.admissions.get(item.idempotencyKey);
    if (!admission || admission.workItemId !== item.workItemId) {
      throw new Error('INBOUND_ENQUEUE_REQUIRES_ADMISSION');
    }
    const workItems = new Map(this.state.workItems);
    workItems.set(item.workItemId, copyWorkItem(item));
    this.state = { ...this.state, workItems };
    return { status: 'ENQUEUED', record: copyWorkItem(item) };
  }

  reserve(workItemId: string, ownerId: string, now: Date, leaseDurationMs: number): InboundQueueReserveResult {
    const existing = this.state.workItems.get(workItemId);
    if (!existing || ownerId.trim().length === 0 || !Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
      return { status: 'NOT_AVAILABLE', record: existing && copyWorkItem(existing) };
    }
    const activeLease = existing.state === 'RESERVED' && existing.leaseExpiresAt && existing.leaseExpiresAt.getTime() > now.getTime();
    const retryWaiting = existing.nextAttemptAt && existing.nextAttemptAt.getTime() > now.getTime();
    if (
      activeLease ||
      retryWaiting ||
      !['QUEUED', 'RESERVED', 'FAILED_RETRYABLE'].includes(existing.state)
    ) {
      return { status: 'NOT_AVAILABLE', record: copyWorkItem(existing) };
    }

    const workItem: InboundWorkItem = {
      ...existing,
      state: 'RESERVED',
      ownerId,
      leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
      nextAttemptAt: undefined,
      attempt: existing.attempt + 1
    };
    const admission = this.requireAdmission(existing.idempotencyKey);
    const updatedAdmission: InboundAdmissionRecord = {
      ...admission,
      state: 'PROCESSING',
      updatedAt: new Date(now.getTime())
    };
    this.commitWorkAndAdmission(workItem, updatedAdmission);
    return { status: 'RESERVED', record: copyWorkItem(workItem) };
  }

  reserveNext(input: InboundQueueReserveNextInput): InboundQueueReserveResult {
    if (
      input.ownerId.trim().length === 0 ||
      Number.isNaN(input.now.getTime()) ||
      !Number.isFinite(input.leaseDurationMs) ||
      input.leaseDurationMs <= 0
    ) {
      return { status: 'NOT_AVAILABLE' };
    }

    const candidate = Array.from(this.state.workItems.values())
      .filter((record) => isReservableWorkItem(record, input.now))
      .sort((left, right) => {
        const availabilityDifference = availableAt(left) - availableAt(right);
        if (availabilityDifference !== 0) return availabilityDifference;
        const enqueueDifference = left.enqueuedAt.getTime() - right.enqueuedAt.getTime();
        if (enqueueDifference !== 0) return enqueueDifference;
        return left.workItemId.localeCompare(right.workItemId);
      })[0];

    return candidate
      ? this.reserve(candidate.workItemId, input.ownerId, input.now, input.leaseDurationMs)
      : { status: 'NOT_AVAILABLE' };
  }

  ack(workItemId: string, ownerId: string, completedAt: Date): InboundWorkItem {
    const existing = this.requireWorkOwner(workItemId, ownerId);
    const workItem: InboundWorkItem = {
      ...existing,
      state: 'COMPLETED',
      ownerId: undefined,
      leaseExpiresAt: undefined,
      nextAttemptAt: undefined,
      failureReasonCode: undefined
    };
    const admission = this.requireAdmission(existing.idempotencyKey);
    const updatedAdmission: InboundAdmissionRecord = {
      ...admission,
      state: 'COMPLETED',
      updatedAt: new Date(completedAt.getTime())
    };
    this.commitWorkAndAdmission(workItem, updatedAdmission);
    return copyWorkItem(workItem);
  }

  nack(
    workItemId: string,
    ownerId: string,
    now: Date,
    reasonCode: string,
    retryPolicy: Omit<RetryPolicyInput, 'attempt' | 'retryability'>
  ): InboundWorkItem {
    const existing = this.requireWorkOwner(workItemId, ownerId);
    const decision = calculateRetryDecision({
      ...retryPolicy,
      attempt: existing.attempt,
      retryability: 'RETRYABLE'
    });
    const nextState: InboundWorkState = decision.retry ? 'FAILED_RETRYABLE' : 'FAILED_FINAL';
    const workItem: InboundWorkItem = {
      ...existing,
      state: nextState,
      ownerId: undefined,
      leaseExpiresAt: undefined,
      nextAttemptAt: decision.retry ? new Date(now.getTime() + (decision.delayMs ?? 0)) : undefined,
      failureReasonCode: reasonCode
    };
    const admission = this.requireAdmission(existing.idempotencyKey);
    const updatedAdmission: InboundAdmissionRecord = {
      ...admission,
      state: decision.retry ? 'FAILED_RETRYABLE' : 'FAILED_FINAL',
      updatedAt: new Date(now.getTime())
    };
    this.commitWorkAndAdmission(workItem, updatedAdmission);
    return copyWorkItem(workItem);
  }

  failFinal(workItemId: string, ownerId: string, now: Date, reasonCode: string): InboundWorkItem {
    const existing = this.requireWorkOwner(workItemId, ownerId);
    const workItem: InboundWorkItem = {
      ...existing,
      state: 'FAILED_FINAL',
      ownerId: undefined,
      leaseExpiresAt: undefined,
      nextAttemptAt: undefined,
      failureReasonCode: reasonCode
    };
    const admission = this.requireAdmission(existing.idempotencyKey);
    const updatedAdmission: InboundAdmissionRecord = {
      ...admission,
      state: 'FAILED_FINAL',
      updatedAt: new Date(now.getTime())
    };
    this.commitWorkAndAdmission(workItem, updatedAdmission);
    return copyWorkItem(workItem);
  }

  get(workItemId: string): InboundWorkItem | undefined {
    const record = this.state.workItems.get(workItemId);
    return record && copyWorkItem(record);
  }

  list(state?: InboundWorkState): readonly InboundWorkItem[] {
    const values = Array.from(this.state.workItems.values());
    return values.filter((item) => !state || item.state === state).map(copyWorkItem);
  }

  /** Compatibility helper for the first F1B-10 draft/tests. */
  getStagedItems(state?: 'STAGED' | 'PROCESSED' | 'FAILED_RETRYABLE' | 'FAILED_PERMANENT'): readonly InboundWorkItem[] {
    const mapped: InboundWorkState | undefined =
      state === 'STAGED' ? 'QUEUED' :
        state === 'PROCESSED' ? 'COMPLETED' :
          state === 'FAILED_RETRYABLE' ? 'FAILED_RETRYABLE' :
            state === 'FAILED_PERMANENT' ? 'FAILED_FINAL' : undefined;
    return this.list(mapped);
  }

  private commitWorkAndAdmission(workItem: InboundWorkItem, admission: InboundAdmissionRecord): void {
    const workItems = new Map(this.state.workItems);
    const admissions = new Map(this.state.admissions);
    workItems.set(workItem.workItemId, workItem);
    admissions.set(admission.idempotencyKey, admission);
    this.state = { ...this.state, workItems, admissions };
  }

  private requireAdmission(idempotencyKey: string): InboundAdmissionRecord {
    const record = this.state.admissions.get(idempotencyKey);
    if (!record) throw new Error('ADMISSION_RECORD_NOT_FOUND');
    return record;
  }

  private requireWorkOwner(workItemId: string, ownerId: string): InboundWorkItem {
    const record = this.state.workItems.get(workItemId);
    if (!record || record.state !== 'RESERVED' || record.ownerId !== ownerId) {
      throw new Error('INBOUND_WORK_OWNER_MISMATCH');
    }
    return record;
  }
}

export function summarizeWebhookBatch(
  requestId: string,
  batchId: string,
  provider: ChannelProvider,
  receivedAt: Date,
  items: readonly WebhookBatchItemResult[]
): WebhookBatchResult {
  const count = (disposition: WebhookItemDisposition) => items.filter((item) => item.disposition === disposition).length;
  return {
    requestId,
    batchId,
    provider,
    receivedAt: new Date(receivedAt.getTime()),
    totalItemCount: items.length,
    admittedCount: count('ADMITTED'),
    duplicateCount: count('DUPLICATE'),
    alreadyProcessingCount: count('ALREADY_PROCESSING'),
    finalRejectedCount: count('FINAL_REJECTED'),
    unsupportedCount: count('UNSUPPORTED'),
    retryableFailureCount: count('RETRYABLE_FAILURE'),
    items: items.map(copyBatchItem)
  };
}

/** LOCAL PROCESSING POLICY. This is not a claim about current Meta retry semantics. */
export function decideWebhookAck(result: WebhookBatchResult): WebhookAckDecision {
  return result.retryableFailureCount > 0 ? 'RETRY_REQUEST' : 'ACKNOWLEDGE';
}
