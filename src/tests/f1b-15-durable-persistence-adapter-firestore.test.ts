import { describe, expect, it, vi } from 'vitest';
import { Timestamp } from '@google-cloud/firestore';
import {
  CHANNEL_GATEWAY_FIRESTORE_COLLECTIONS,
  FirestoreDurableWebhookIngressStore,
  deserializeWorkItem,
  serializeWorkItem
} from '../../services/channel-gateway/adapters/firestore';
import type { AdmitInboundItemInput, InboundWorkItem } from '../../services/channel-gateway/ingress';

const now = new Date('2026-09-18T12:00:00.000Z');

type StoredDocument = Record<string, unknown>;

function cloneStored<T>(value: T): T {
  if (value instanceof Timestamp) return value as T;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map(cloneStored) as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) output[key] = cloneStored(nested);
    return output as T;
  }
  return value;
}

class FakeDocumentSnapshot {
  constructor(readonly path: string, private readonly value: StoredDocument | undefined) {}
  get exists() { return this.value !== undefined; }
  data() { return this.value ? cloneStored(this.value) : undefined; }
}

class FakeQuerySnapshot {
  constructor(readonly docs: FakeDocumentSnapshot[]) {}
}

type Filter = { field: string; op: '==' | '<='; value: unknown };
type Ordering = { field: string; direction: 'asc' | 'desc' };

function comparable(value: unknown): number | string | boolean | null {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === 'object' && 'toDate' in value && typeof (value as { toDate: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().getTime();
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value as number | string | boolean | null;
  }
  throw new Error('UNSUPPORTED_FAKE_COMPARISON');
}

class FakeQuery {
  constructor(
    protected readonly db: FakeFirestore,
    protected readonly collectionPath: string,
    private readonly filters: Filter[] = [],
    private readonly orderings: Ordering[] = [],
    private readonly max?: number
  ) {}

  where(field: string, op: '==' | '<=', value: unknown) {
    return new FakeQuery(this.db, this.collectionPath, [...this.filters, { field, op, value }], this.orderings, this.max);
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc') {
    return new FakeQuery(this.db, this.collectionPath, this.filters, [...this.orderings, { field, direction }], this.max);
  }

  limit(max: number) {
    return new FakeQuery(this.db, this.collectionPath, this.filters, this.orderings, max);
  }

  async get() {
    return this.db.query(this.collectionPath, this.filters, this.orderings, this.max);
  }
}

class FakeCollection extends FakeQuery {
  doc(id: string) {
    return new FakeDocumentReference(this.db, `${this.collectionPath}/${id}`);
  }
}

class FakeDocumentReference {
  constructor(private readonly db: FakeFirestore, readonly path: string) {}
  async get() {
    return this.db.getSnapshot(this.path);
  }
  async set(value: StoredDocument) {
    this.db.set(this.path, value);
  }
}

class FakeTransaction {
  private readonly writes = new Map<string, StoredDocument>();

  constructor(private readonly db: FakeFirestore) {}

  async get(refOrQuery: FakeDocumentReference | FakeQuery) {
    if (refOrQuery instanceof FakeQuery) return refOrQuery.get();
    const pending = this.writes.get(refOrQuery.path);
    return pending ? new FakeDocumentSnapshot(refOrQuery.path, pending) : this.db.getSnapshot(refOrQuery.path);
  }

  set(ref: FakeDocumentReference, value: StoredDocument) {
    this.writes.set(ref.path, cloneStored(value));
  }

  update(ref: FakeDocumentReference, value: StoredDocument) {
    const current = this.writes.get(ref.path) ?? this.db.read(ref.path);
    if (!current) throw new Error('FAKE_DOCUMENT_NOT_FOUND');
    this.writes.set(ref.path, { ...cloneStored(current), ...cloneStored(value) });
  }

  commit() {
    for (const [path, value] of this.writes) this.db.set(path, value);
  }
}

class FakeFirestore {
  private documents = new Map<string, StoredDocument>();
  private transactionChain = Promise.resolve();
  failNextCommit = false;

  doc(path: string) {
    return new FakeDocumentReference(this, path);
  }

  collection(path: string) {
    return new FakeCollection(this, path);
  }

  async runTransaction<T>(callback: (transaction: FakeTransaction) => Promise<T>): Promise<T> {
    const run = async () => {
      const transaction = new FakeTransaction(this);
      const result = await callback(transaction);
      if (this.failNextCommit) {
        this.failNextCommit = false;
        throw new Error('SYNTHETIC_TRANSACTION_COMMIT_FAILURE');
      }
      transaction.commit();
      return result;
    };
    const result = this.transactionChain.then(run, run);
    this.transactionChain = result.then(() => undefined, () => undefined);
    return result;
  }

  read(path: string) {
    const value = this.documents.get(path);
    return value ? cloneStored(value) : undefined;
  }

  set(path: string, value: StoredDocument) {
    this.documents.set(path, cloneStored(value));
  }

  getSnapshot(path: string) {
    return new FakeDocumentSnapshot(path, this.read(path));
  }

  query(collectionPath: string, filters: Filter[], orderings: Ordering[], max?: number) {
    const prefix = `${collectionPath}/`;
    let docs = Array.from(this.documents.entries())
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, value]) => new FakeDocumentSnapshot(path, value));

    docs = docs.filter((doc) => {
      const data = doc.data()!;
      return filters.every((filter) => {
        const left = comparable(data[filter.field]);
        const right = comparable(filter.value);
        return filter.op === '==' ? left === right : Number(left) <= Number(right);
      });
    });

    docs.sort((leftDoc, rightDoc) => {
      const left = leftDoc.data()!;
      const right = rightDoc.data()!;
      for (const ordering of orderings) {
        const leftValue = comparable(left[ordering.field]);
        const rightValue = comparable(right[ordering.field]);
        const difference = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
        if (difference !== 0) return ordering.direction === 'asc' ? difference : -difference;
      }
      return leftDoc.path.localeCompare(rightDoc.path);
    });

    return new FakeQuerySnapshot(max === undefined ? docs : docs.slice(0, max));
  }
}

function firestoreStore(db = new FakeFirestore()) {
  return {
    db,
    store: new FirestoreDurableWebhookIngressStore(db as never)
  };
}

function input(workItemId: string, idempotencyKey: string, admittedAt = now): AdmitInboundItemInput {
  return {
    idempotencyKey,
    workItemId,
    provider: 'WHATSAPP_META_OFFICIAL',
    providerEventId: `provider-${workItemId}`,
    rawEventKind: 'message',
    event: {
      internalEventId: `event-${workItemId}`,
      occurredAt: admittedAt,
      provider: 'WHATSAPP_META_OFFICIAL',
      channel: 'WHATSAPP',
      eventType: 'INBOUND_MESSAGE',
      payload: {
        providerAddress: '+15555550123',
        externalConversationId: 'conversation-1',
        content: { contentType: 'TEXT', text: 'Sensitive F1B-15 payload' }
      }
    },
    admittedAt
  };
}

async function reservedWork(store: FirestoreDurableWebhookIngressStore, suffix: string) {
  await store.admit(input(`work-${suffix}`, `idem-${suffix}`));
  const reserved = await store.reserve(`work-${suffix}`, 'owner-a', now, 30_000);
  expect(reserved.status).toBe('RESERVED');
  return reserved.record!;
}

describe('F1B-15 Firestore durable persistence adapter', () => {
  it('1. atomically creates admission and work item, and rolls back both on commit failure', async () => {
    const { db, store } = firestoreStore();
    const admitted = await store.admit(input('work-atomic', 'idem-atomic'));
    expect(admitted.disposition).toBe('ADMITTED');
    expect(await store.getAdmission('idem-atomic')).toMatchObject({ workItemId: 'work-atomic', state: 'ADMITTED' });
    expect(await store.get('work-atomic')).toMatchObject({ idempotencyKey: 'idem-atomic', state: 'QUEUED' });

    db.failNextCommit = true;
    await expect(store.admit(input('work-rollback', 'idem-rollback'))).rejects.toThrow('SYNTHETIC_TRANSACTION_COMMIT_FAILURE');
    expect(await store.getAdmission('idem-rollback')).toBeUndefined();
    expect(await store.get('work-rollback')).toBeUndefined();
  });

  it('2. preserves idempotency and does not duplicate work for the same key', async () => {
    const { store } = firestoreStore();
    await store.admit(input('work-original', 'idem-shared'));
    const duplicate = await store.admit(input('work-other', 'idem-shared'));
    expect(duplicate.disposition).toBe('DUPLICATE');
    expect((await store.list()).map((item) => item.workItemId)).toEqual(['work-original']);
  });

  it('3. rejects inconsistent work item id collisions', async () => {
    const { store } = firestoreStore();
    await store.admit(input('work-collision', 'idem-a'));
    await expect(store.admit(input('work-collision', 'idem-b'))).rejects.toThrow('WORK_ITEM_ID_COLLISION');
    expect(await store.getAdmission('idem-b')).toBeUndefined();
  });

  it('4. reserves queued work, updates admission, and blocks another active owner', async () => {
    const { store } = firestoreStore();
    await store.admit(input('work-reserve', 'idem-reserve'));
    const first = await store.reserve('work-reserve', 'owner-a', now, 30_000);
    const second = await store.reserve('work-reserve', 'owner-b', new Date(now.getTime() + 1), 30_000);
    expect(first).toMatchObject({ status: 'RESERVED', record: { ownerId: 'owner-a', attempt: 1 } });
    expect(second.status).toBe('NOT_AVAILABLE');
    expect(await store.getAdmission('idem-reserve')).toMatchObject({ state: 'PROCESSING' });
  });

  it('5. reserveNext chooses deterministic eligible work and does not expose an active lease twice', async () => {
    const { store } = firestoreStore();
    await store.admit(input('work-b', 'idem-b', new Date(now.getTime() + 2)));
    await store.admit(input('work-a', 'idem-a', new Date(now.getTime() + 1)));
    const [first, second] = await Promise.all([
      store.reserveNext({ ownerId: 'owner-a', now, leaseDurationMs: 30_000 }),
      store.reserveNext({ ownerId: 'owner-b', now, leaseDurationMs: 30_000 })
    ]);
    expect(first).toMatchObject({ status: 'RESERVED', record: { workItemId: 'work-a', ownerId: 'owner-a' } });
    expect(second).toMatchObject({ status: 'RESERVED', record: { workItemId: 'work-b', ownerId: 'owner-b' } });
    expect(first.record?.workItemId).not.toBe(second.record?.workItemId);
  });

  it('6. recovers expired leases and keeps retryable failures ineligible until scheduled time', async () => {
    const { store } = firestoreStore();
    await reservedWork(store, 'retry');
    const failed = await store.nack('work-retry', 'owner-a', now, 'PROVIDER_UNAVAILABLE', {
      maxAttempts: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 5_000
    });
    expect(failed).toMatchObject({ state: 'FAILED_RETRYABLE', attempt: 1 });
    expect((await store.reserveNext({ ownerId: 'owner-b', now, leaseDurationMs: 30_000 })).status).toBe('NOT_AVAILABLE');
    expect((await store.reserveNext({
      ownerId: 'owner-b',
      now: new Date(now.getTime() + 1_001),
      leaseDurationMs: 30_000
    }))).toMatchObject({ status: 'RESERVED', record: { ownerId: 'owner-b', attempt: 2 } });

    await store.admit(input('work-crash', 'idem-crash'));
    await store.reserve('work-crash', 'owner-a', now, 30_000);
    const recovered = await store.reserve('work-crash', 'owner-b', new Date(now.getTime() + 30_001), 30_000);
    expect(recovered).toMatchObject({ status: 'RESERVED', record: { ownerId: 'owner-b', attempt: 2 } });
  });

  it('7. ack, nack exhaustion, and failFinal update work and admission in one transaction', async () => {
    const { store } = firestoreStore();
    await reservedWork(store, 'ack');
    await expect(store.ack('work-ack', 'owner-b', now)).rejects.toThrow('INBOUND_WORK_OWNER_MISMATCH');
    const completed = await store.ack('work-ack', 'owner-a', now);
    expect(completed).toMatchObject({ state: 'COMPLETED', ownerId: undefined, leaseExpiresAt: undefined });
    expect(await store.getAdmission('idem-ack')).toMatchObject({ state: 'COMPLETED' });

    await reservedWork(store, 'exhausted');
    const finalByNack = await store.nack('work-exhausted', 'owner-a', now, 'RATE_LIMITED', {
      maxAttempts: 1,
      baseDelayMs: 100,
      maxDelayMs: 100
    });
    expect(finalByNack).toMatchObject({ state: 'FAILED_FINAL', failureReasonCode: 'RATE_LIMITED' });
    expect(await store.getAdmission('idem-exhausted')).toMatchObject({ state: 'FAILED_FINAL' });

    await reservedWork(store, 'final');
    const failed = await store.failFinal('work-final', 'owner-a', now, 'IDENTITY_REJECTED');
    expect(failed).toMatchObject({ state: 'FAILED_FINAL', failureReasonCode: 'IDENTITY_REJECTED' });
    expect(await store.getAdmission('idem-final')).toMatchObject({ state: 'FAILED_FINAL' });
  });

  it('8. serializes dates as Firestore timestamps and round-trips the sensitive payload without logging it', async () => {
    const { db, store } = firestoreStore();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await store.admit(input('work-serialization', 'idem-serialization'));

    const raw = db.read(`${CHANNEL_GATEWAY_FIRESTORE_COLLECTIONS.WORK_ITEMS}/work-serialization`)!;
    expect(raw.enqueuedAt).toBeInstanceOf(Timestamp);
    expect((raw.event as { occurredAt: unknown }).occurredAt).toBeInstanceOf(Timestamp);

    const roundTrip = deserializeWorkItem(serializeWorkItem((await store.get('work-serialization')) as InboundWorkItem));
    expect(roundTrip.enqueuedAt.toISOString()).toBe(now.toISOString());
    expect(roundTrip.event.occurredAt.toISOString()).toBe(now.toISOString());
    expect(roundTrip.event.payload.content).toMatchObject({ text: 'Sensitive F1B-15 payload' });
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('9. keeps the gateway/domain boundary free from Firestore imports outside the adapter', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const readTree = (directory: string): string => fs.readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory() && entry.name === 'adapters') return [];
        return entry.isDirectory()
          ? [readTree(fullPath)]
          : entry.name.endsWith('.ts') ? [fs.readFileSync(fullPath, 'utf8')] : [];
      })
      .join('\n');
    const domain = readTree(path.resolve(process.cwd(), 'src/domain'));
    const gatewayWithoutAdapters = readTree(path.resolve(process.cwd(), 'services/channel-gateway'));

    expect(domain).not.toMatch(/firebase|firestore|@google-cloud\/firestore/i);
    expect(gatewayWithoutAdapters).not.toMatch(/(?:firebase|@google-cloud\/firestore)/i);
  });
});
