import type {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Query,
  QuerySnapshot,
  Transaction
} from '@google-cloud/firestore';
import type { RetryPolicyInput } from '../../retryPolicy';
import { calculateRetryDecision } from '../../retryPolicy';
import type {
  AdmitInboundItemInput,
  AdmitInboundItemResult,
  DurableIngressBatchRecord,
  InboundAdmissionRecord,
  InboundQueueEnqueueResult,
  InboundQueueReserveNextInput,
  InboundQueueReserveResult,
  InboundWorkItem,
  InboundWorkState,
  RecordIngressBatchInput
} from '../../ingress';
import {
  deserializeAdmission,
  deserializeBatch,
  deserializeWorkItem,
  encodeFirestoreDocumentId,
  serializeAdmission,
  serializeBatch,
  serializeWorkItem,
  toGatewayTimestamp
} from './serialization';

export const CHANNEL_GATEWAY_FIRESTORE_COLLECTIONS = {
  ADMISSIONS: 'channelGatewayInboundAdmissions',
  WORK_ITEMS: 'channelGatewayInboundWorkItems',
  INGRESS_BATCHES: 'channelGatewayIngressBatches'
} as const;

type GatewayDocumentReference = DocumentReference;
type GatewayCollectionReference = CollectionReference;
type GatewayQuery = Query;
type GatewayDocumentSnapshot = DocumentSnapshot;
type GatewayQuerySnapshot = QuerySnapshot;
type GatewayTransaction = Pick<Transaction, 'get' | 'set' | 'update'>;
type GatewayFirestore = Pick<Firestore, 'collection' | 'doc' | 'runTransaction'>;

function admissionPath(idempotencyKey: string): string {
  return `${CHANNEL_GATEWAY_FIRESTORE_COLLECTIONS.ADMISSIONS}/${encodeFirestoreDocumentId(idempotencyKey)}`;
}

function workItemPath(workItemId: string): string {
  return `${CHANNEL_GATEWAY_FIRESTORE_COLLECTIONS.WORK_ITEMS}/${encodeFirestoreDocumentId(workItemId)}`;
}

function batchPath(ingressBatchId: string): string {
  return `${CHANNEL_GATEWAY_FIRESTORE_COLLECTIONS.INGRESS_BATCHES}/${encodeFirestoreDocumentId(ingressBatchId)}`;
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

function isReservable(record: InboundWorkItem, now: Date): boolean {
  if (record.state === 'QUEUED') return true;
  if (record.state === 'RESERVED') return !record.leaseExpiresAt || record.leaseExpiresAt.getTime() <= now.getTime();
  if (record.state === 'FAILED_RETRYABLE') return !record.nextAttemptAt || record.nextAttemptAt.getTime() <= now.getTime();
  return false;
}

function availableAt(record: InboundWorkItem): number {
  if (record.state === 'RESERVED') return record.leaseExpiresAt?.getTime() ?? record.enqueuedAt.getTime();
  if (record.state === 'FAILED_RETRYABLE') return record.nextAttemptAt?.getTime() ?? record.enqueuedAt.getTime();
  return record.enqueuedAt.getTime();
}

function readAdmission(snapshot: GatewayDocumentSnapshot): InboundAdmissionRecord | undefined {
  return snapshot.exists ? deserializeAdmission(snapshot.data()) : undefined;
}

function readWorkItem(snapshot: GatewayDocumentSnapshot): InboundWorkItem | undefined {
  return snapshot.exists ? deserializeWorkItem(snapshot.data()) : undefined;
}

function assertValidReserveInput(ownerId: string, now: Date, leaseDurationMs: number): boolean {
  return ownerId.trim().length > 0 &&
    !Number.isNaN(now.getTime()) &&
    Number.isFinite(leaseDurationMs) &&
    leaseDurationMs > 0;
}

/**
 * Durable server-side Firestore adapter for F1B-15. It mirrors the existing
 * inbound persistence port operations, but remains async because Firestore
 * transactions are async. It is not wired into the offline synchronous gateway
 * runtime in this phase.
 */
export class FirestoreDurableWebhookIngressStore {
  constructor(private readonly firestore: GatewayFirestore) {}

  async admit(input: AdmitInboundItemInput): Promise<AdmitInboundItemResult> {
    return this.firestore.runTransaction(async (transaction) => {
      const admissionRef = this.firestore.doc(admissionPath(input.idempotencyKey));
      const workRef = this.firestore.doc(workItemPath(input.workItemId));
      const [admissionSnapshot, workSnapshot] = await Promise.all([
        transaction.get(admissionRef),
        transaction.get(workRef)
      ]);
      const existingAdmission = readAdmission(admissionSnapshot);
      if (existingAdmission) {
        const existingWorkSnapshot = await transaction.get(this.firestore.doc(workItemPath(existingAdmission.workItemId)));
        const existingWork = readWorkItem(existingWorkSnapshot);
        return {
          disposition: dispositionForExisting(existingAdmission),
          admission: existingAdmission,
          ...(existingWork ? { workItem: existingWork } : {})
        };
      }
      const existingWork = readWorkItem(workSnapshot);
      if (existingWork) throw new Error('WORK_ITEM_ID_COLLISION');

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
        event: input.event,
        state: 'QUEUED',
        attempt: 0,
        enqueuedAt: new Date(input.admittedAt.getTime())
      };
      transaction.set(admissionRef, serializeAdmission(admission));
      transaction.set(workRef, serializeWorkItem(workItem));
      return { disposition: 'ADMITTED', admission, workItem };
    });
  }

  async getAdmission(idempotencyKey: string): Promise<InboundAdmissionRecord | undefined> {
    const snapshot = await this.firestore.doc(admissionPath(idempotencyKey)).get();
    return readAdmission(snapshot);
  }

  async recordBatch(input: RecordIngressBatchInput): Promise<DurableIngressBatchRecord> {
    if (input.ingressBatchId.trim().length === 0 || input.correlationId.trim().length === 0) {
      throw new Error('INVALID_INGRESS_BATCH_INPUT');
    }
    const record: DurableIngressBatchRecord = {
      ...input.result,
      ingressBatchId: input.ingressBatchId,
      correlationId: input.correlationId
    };
    await this.firestore.doc(batchPath(input.ingressBatchId)).set(serializeBatch(record));
    return record;
  }

  async getBatch(ingressBatchId: string): Promise<DurableIngressBatchRecord | undefined> {
    const snapshot = await this.firestore.doc(batchPath(ingressBatchId)).get();
    return snapshot.exists ? deserializeBatch(snapshot.data()) : undefined;
  }

  async enqueue(item: InboundWorkItem): Promise<InboundQueueEnqueueResult> {
    return this.firestore.runTransaction(async (transaction) => {
      const workRef = this.firestore.doc(workItemPath(item.workItemId));
      const workSnapshot = await transaction.get(workRef);
      const existing = readWorkItem(workSnapshot);
      if (existing) return { status: 'DUPLICATE', record: existing };
      const admission = readAdmission(await transaction.get(this.firestore.doc(admissionPath(item.idempotencyKey))));
      if (!admission || admission.workItemId !== item.workItemId) throw new Error('INBOUND_ENQUEUE_REQUIRES_ADMISSION');
      transaction.set(workRef, serializeWorkItem(item));
      return { status: 'ENQUEUED', record: item };
    });
  }

  async reserve(workItemId: string, ownerId: string, now: Date, leaseDurationMs: number): Promise<InboundQueueReserveResult> {
    if (!assertValidReserveInput(ownerId, now, leaseDurationMs)) return { status: 'NOT_AVAILABLE' };
    return this.firestore.runTransaction(async (transaction) => {
      const workRef = this.firestore.doc(workItemPath(workItemId));
      const existing = readWorkItem(await transaction.get(workRef));
      if (!existing || !isReservable(existing, now)) return { status: 'NOT_AVAILABLE', ...(existing ? { record: existing } : {}) };
      return this.reserveExisting(transaction, existing, ownerId, now, leaseDurationMs);
    });
  }

  async reserveNext(input: InboundQueueReserveNextInput): Promise<InboundQueueReserveResult> {
    if (!assertValidReserveInput(input.ownerId, input.now, input.leaseDurationMs)) return { status: 'NOT_AVAILABLE' };
    return this.firestore.runTransaction(async (transaction) => {
      const candidates = await this.readReserveNextCandidates(transaction, input.now);
      const candidate = candidates
        .filter((record) => isReservable(record, input.now))
        .sort((left, right) => {
          const availableDifference = availableAt(left) - availableAt(right);
          if (availableDifference !== 0) return availableDifference;
          const enqueuedDifference = left.enqueuedAt.getTime() - right.enqueuedAt.getTime();
          if (enqueuedDifference !== 0) return enqueuedDifference;
          return left.workItemId.localeCompare(right.workItemId);
        })[0];
      return candidate
        ? this.reserveExisting(transaction, candidate, input.ownerId, input.now, input.leaseDurationMs)
        : { status: 'NOT_AVAILABLE' };
    });
  }

  async ack(workItemId: string, ownerId: string, completedAt: Date): Promise<InboundWorkItem> {
    return this.firestore.runTransaction(async (transaction) => {
      const existing = await this.requireWorkOwner(transaction, workItemId, ownerId);
      const workItem: InboundWorkItem = {
        ...existing,
        state: 'COMPLETED',
        ownerId: undefined,
        leaseExpiresAt: undefined,
        nextAttemptAt: undefined,
        failureReasonCode: undefined
      };
      await this.commitWorkAndAdmission(transaction, workItem, 'COMPLETED', completedAt);
      return workItem;
    });
  }

  async nack(
    workItemId: string,
    ownerId: string,
    now: Date,
    reasonCode: string,
    retryPolicy: Omit<RetryPolicyInput, 'attempt' | 'retryability'>
  ): Promise<InboundWorkItem> {
    return this.firestore.runTransaction(async (transaction) => {
      const existing = await this.requireWorkOwner(transaction, workItemId, ownerId);
      const decision = calculateRetryDecision({ ...retryPolicy, attempt: existing.attempt, retryability: 'RETRYABLE' });
      const state = decision.retry ? 'FAILED_RETRYABLE' : 'FAILED_FINAL';
      const workItem: InboundWorkItem = {
        ...existing,
        state,
        ownerId: undefined,
        leaseExpiresAt: undefined,
        nextAttemptAt: decision.retry ? new Date(now.getTime() + (decision.delayMs ?? 0)) : undefined,
        failureReasonCode: reasonCode
      };
      await this.commitWorkAndAdmission(transaction, workItem, state, now);
      return workItem;
    });
  }

  async failFinal(workItemId: string, ownerId: string, now: Date, reasonCode: string): Promise<InboundWorkItem> {
    return this.firestore.runTransaction(async (transaction) => {
      const existing = await this.requireWorkOwner(transaction, workItemId, ownerId);
      const workItem: InboundWorkItem = {
        ...existing,
        state: 'FAILED_FINAL',
        ownerId: undefined,
        leaseExpiresAt: undefined,
        nextAttemptAt: undefined,
        failureReasonCode: reasonCode
      };
      await this.commitWorkAndAdmission(transaction, workItem, 'FAILED_FINAL', now);
      return workItem;
    });
  }

  async get(workItemId: string): Promise<InboundWorkItem | undefined> {
    return readWorkItem(await this.firestore.doc(workItemPath(workItemId)).get());
  }

  async list(state?: InboundWorkState): Promise<readonly InboundWorkItem[]> {
    let query: GatewayQuery | GatewayCollectionReference = this.firestore.collection(CHANNEL_GATEWAY_FIRESTORE_COLLECTIONS.WORK_ITEMS);
    if (state) query = query.where('state', '==', state);
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => deserializeWorkItem(doc.data()));
  }

  private async readReserveNextCandidates(transaction: GatewayTransaction, now: Date): Promise<InboundWorkItem[]> {
    const workItems = this.firestore.collection(CHANNEL_GATEWAY_FIRESTORE_COLLECTIONS.WORK_ITEMS);
    const [queued, retryable, expired] = await Promise.all([
      transaction.get(workItems.where('state', '==', 'QUEUED').orderBy('enqueuedAt', 'asc').limit(10)),
      transaction.get(workItems
        .where('state', '==', 'FAILED_RETRYABLE')
        .where('nextAttemptAt', '<=', toGatewayTimestamp(now))
        .orderBy('nextAttemptAt', 'asc')
        .orderBy('enqueuedAt', 'asc')
        .limit(10)),
      transaction.get(workItems
        .where('state', '==', 'RESERVED')
        .where('leaseExpiresAt', '<=', toGatewayTimestamp(now))
        .orderBy('leaseExpiresAt', 'asc')
        .orderBy('enqueuedAt', 'asc')
        .limit(10))
    ]);
    return [...queued.docs, ...retryable.docs, ...expired.docs].map((doc) => deserializeWorkItem(doc.data()));
  }

  private async reserveExisting(
    transaction: GatewayTransaction,
    existing: InboundWorkItem,
    ownerId: string,
    now: Date,
    leaseDurationMs: number
  ): Promise<InboundQueueReserveResult> {
    const current = readWorkItem(await transaction.get(this.firestore.doc(workItemPath(existing.workItemId))));
    if (!current || !isReservable(current, now)) return { status: 'NOT_AVAILABLE', ...(current ? { record: current } : {}) };
    const workItem: InboundWorkItem = {
      ...current,
      state: 'RESERVED',
      ownerId,
      leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
      nextAttemptAt: undefined,
      attempt: current.attempt + 1
    };
    await this.commitWorkAndAdmission(transaction, workItem, 'PROCESSING', now);
    return { status: 'RESERVED', record: workItem };
  }

  private async commitWorkAndAdmission(
    transaction: GatewayTransaction,
    workItem: InboundWorkItem,
    admissionState: InboundAdmissionRecord['state'],
    updatedAt: Date
  ): Promise<void> {
    const admissionRef = this.firestore.doc(admissionPath(workItem.idempotencyKey));
    const admission = readAdmission(await transaction.get(admissionRef));
    if (!admission || admission.workItemId !== workItem.workItemId) throw new Error('ADMISSION_RECORD_NOT_FOUND');
    transaction.set(this.firestore.doc(workItemPath(workItem.workItemId)), serializeWorkItem(workItem));
    transaction.set(admissionRef, serializeAdmission({
      ...admission,
      state: admissionState,
      updatedAt: new Date(updatedAt.getTime())
    }));
  }

  private async requireWorkOwner(
    transaction: GatewayTransaction,
    workItemId: string,
    ownerId: string
  ): Promise<InboundWorkItem> {
    const record = readWorkItem(await transaction.get(this.firestore.doc(workItemPath(workItemId))));
    if (!record || record.state !== 'RESERVED' || record.ownerId !== ownerId) {
      throw new Error('INBOUND_WORK_OWNER_MISMATCH');
    }
    return record;
  }
}
