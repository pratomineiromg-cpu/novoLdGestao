export type DurableIdempotencyState =
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL';

export interface DurableIdempotencyRecord {
  key: string;
  state: DurableIdempotencyState;
  ownerId?: string;
  attempt: number;
  startedAt: Date;
  leaseExpiresAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  failureClassification?: 'RETRYABLE' | 'NON_RETRYABLE';
}

export type IdempotencyAcquireStatus =
  | 'ACQUIRED'
  | 'ALREADY_PROCESSING'
  | 'ALREADY_COMPLETED'
  | 'RETRY_ALLOWED'
  | 'FINAL_FAILURE';

export interface IdempotencyAcquireResult {
  status: IdempotencyAcquireStatus;
  record: DurableIdempotencyRecord;
}

export interface IdempotencyAcquireInput {
  key: string;
  ownerId: string;
  now: Date;
  leaseDurationMs: number;
}

export interface DurableIdempotencyStore {
  tryAcquire(input: IdempotencyAcquireInput): IdempotencyAcquireResult;
  complete(key: string, ownerId: string, completedAt: Date): DurableIdempotencyRecord;
  fail(
    key: string,
    ownerId: string,
    failedAt: Date,
    classification: 'RETRYABLE' | 'NON_RETRYABLE'
  ): DurableIdempotencyRecord;
  get(key: string): DurableIdempotencyRecord | undefined;
}

function copyRecord(record: DurableIdempotencyRecord): DurableIdempotencyRecord {
  return {
    ...record,
    startedAt: new Date(record.startedAt.getTime()),
    leaseExpiresAt: record.leaseExpiresAt && new Date(record.leaseExpiresAt.getTime()),
    completedAt: record.completedAt && new Date(record.completedAt.getTime()),
    failedAt: record.failedAt && new Date(record.failedAt.getTime())
  };
}

/** Reference semantics only. This Map is NOT PRODUCTION DURABLE STORAGE. */
export class InMemoryDurableIdempotencyStore implements DurableIdempotencyStore {
  private readonly records = new Map<string, DurableIdempotencyRecord>();

  tryAcquire(input: IdempotencyAcquireInput): IdempotencyAcquireResult {
    if (
      input.key.trim().length === 0 ||
      input.ownerId.trim().length === 0 ||
      !Number.isFinite(input.leaseDurationMs) ||
      input.leaseDurationMs <= 0 ||
      Number.isNaN(input.now.getTime())
    ) {
      throw new Error('INVALID_IDEMPOTENCY_ACQUIRE');
    }

    const existing = this.records.get(input.key);
    if (existing?.state === 'COMPLETED') {
      return { status: 'ALREADY_COMPLETED', record: copyRecord(existing) };
    }
    if (existing?.state === 'FAILED_FINAL') {
      return { status: 'FINAL_FAILURE', record: copyRecord(existing) };
    }
    if (
      existing?.state === 'PROCESSING' &&
      existing.leaseExpiresAt &&
      existing.leaseExpiresAt.getTime() > input.now.getTime()
    ) {
      return { status: 'ALREADY_PROCESSING', record: copyRecord(existing) };
    }

    const status: IdempotencyAcquireStatus = existing ? 'RETRY_ALLOWED' : 'ACQUIRED';
    const record: DurableIdempotencyRecord = {
      key: input.key,
      state: 'PROCESSING',
      ownerId: input.ownerId,
      attempt: (existing?.attempt ?? 0) + 1,
      startedAt: new Date(input.now.getTime()),
      leaseExpiresAt: new Date(input.now.getTime() + input.leaseDurationMs)
    };
    this.records.set(input.key, record);
    return { status, record: copyRecord(record) };
  }

  complete(key: string, ownerId: string, completedAt: Date): DurableIdempotencyRecord {
    const record = this.requireOwner(key, ownerId);
    const completed: DurableIdempotencyRecord = {
      ...record,
      state: 'COMPLETED',
      ownerId: undefined,
      leaseExpiresAt: undefined,
      completedAt: new Date(completedAt.getTime())
    };
    this.records.set(key, completed);
    return copyRecord(completed);
  }

  fail(
    key: string,
    ownerId: string,
    failedAt: Date,
    classification: 'RETRYABLE' | 'NON_RETRYABLE'
  ): DurableIdempotencyRecord {
    const record = this.requireOwner(key, ownerId);
    const failed: DurableIdempotencyRecord = {
      ...record,
      state: classification === 'RETRYABLE' ? 'FAILED_RETRYABLE' : 'FAILED_FINAL',
      ownerId: undefined,
      leaseExpiresAt: undefined,
      failedAt: new Date(failedAt.getTime()),
      failureClassification: classification
    };
    this.records.set(key, failed);
    return copyRecord(failed);
  }

  get(key: string): DurableIdempotencyRecord | undefined {
    const record = this.records.get(key);
    return record && copyRecord(record);
  }

  private requireOwner(key: string, ownerId: string): DurableIdempotencyRecord {
    const record = this.records.get(key);
    if (!record || record.state !== 'PROCESSING' || record.ownerId !== ownerId) {
      throw new Error('IDEMPOTENCY_OWNER_MISMATCH');
    }
    return record;
  }
}
