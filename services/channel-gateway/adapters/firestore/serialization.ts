import { Timestamp } from '@google-cloud/firestore';
import type { NormalizedChannelEvent } from '../../contracts';
import type {
  DurableIngressBatchRecord,
  InboundAdmissionRecord,
  InboundWorkItem,
  WebhookBatchResult
} from '../../ingress';

type FirestorePrimitive = string | number | boolean | null;
type FirestoreValue = FirestorePrimitive | Timestamp | FirestoreValue[] | { [key: string]: FirestoreValue };

export type FirestoreDocument = Record<string, FirestoreValue>;

export function encodeFirestoreDocumentId(value: string): string {
  if (value.trim().length === 0) throw new Error('INVALID_FIRESTORE_DOCUMENT_ID');
  return encodeURIComponent(value);
}

export function toGatewayTimestamp(date: Date): Timestamp {
  if (Number.isNaN(date.getTime())) throw new Error('INVALID_GATEWAY_TIMESTAMP');
  return Timestamp.fromDate(date);
}

export function fromGatewayTimestamp(value: unknown): Date {
  if (!value) throw new Error('MISSING_GATEWAY_TIMESTAMP');
  if (value instanceof Timestamp) return value.toDate();
  if (
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  if (
    typeof value === 'object' &&
    'seconds' in value &&
    typeof (value as { seconds: unknown }).seconds === 'number'
  ) {
    const nanos = 'nanoseconds' in value && typeof (value as { nanoseconds: unknown }).nanoseconds === 'number'
      ? (value as { nanoseconds: number }).nanoseconds
      : 0;
    return new Timestamp((value as { seconds: number }).seconds, nanos).toDate();
  }
  if (
    typeof value === 'object' &&
    '_seconds' in value &&
    typeof (value as { _seconds: unknown })._seconds === 'number'
  ) {
    const nanos = '_nanoseconds' in value && typeof (value as { _nanoseconds: unknown })._nanoseconds === 'number'
      ? (value as { _nanoseconds: number })._nanoseconds
      : 0;
    return new Timestamp((value as { _seconds: number })._seconds, nanos).toDate();
  }
  throw new Error('INVALID_GATEWAY_TIMESTAMP');
}

function serializeValue(value: unknown): FirestoreValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value as FirestorePrimitive;
  }
  if (value instanceof Date) return toGatewayTimestamp(value);
  if (Array.isArray(value)) return value.map((item) => serializeValue(item) ?? null) as FirestoreValue[];
  if (typeof value === 'object') {
    const output: Record<string, FirestoreValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      const serialized = serializeValue(nested);
      if (serialized !== undefined) output[key] = serialized;
    }
    return output;
  }
  throw new Error('UNSUPPORTED_FIRESTORE_VALUE');
}

function deserializeValue(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate();
  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate: unknown }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  if (Array.isArray(value)) return value.map(deserializeValue);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) output[key] = deserializeValue(nested);
    return output;
  }
  return value;
}

export function serializeAdmission(record: InboundAdmissionRecord): FirestoreDocument {
  return serializeValue(record) as FirestoreDocument;
}

export function deserializeAdmission(data: unknown): InboundAdmissionRecord {
  const parsed = deserializeValue(data) as InboundAdmissionRecord;
  return {
    ...parsed,
    admittedAt: new Date(parsed.admittedAt),
    updatedAt: new Date(parsed.updatedAt)
  };
}

export function serializeWorkItem(record: InboundWorkItem): FirestoreDocument {
  return serializeValue(record) as FirestoreDocument;
}

export function deserializeWorkItem(data: unknown): InboundWorkItem {
  const parsed = deserializeValue(data) as InboundWorkItem;
  return {
    ...parsed,
    enqueuedAt: new Date(parsed.enqueuedAt),
    leaseExpiresAt: parsed.leaseExpiresAt && new Date(parsed.leaseExpiresAt),
    nextAttemptAt: parsed.nextAttemptAt && new Date(parsed.nextAttemptAt),
    event: {
      ...parsed.event,
      occurredAt: new Date((parsed.event as NormalizedChannelEvent).occurredAt)
    }
  };
}

export function serializeBatch(record: DurableIngressBatchRecord): FirestoreDocument {
  return serializeValue(record) as FirestoreDocument;
}

export function deserializeBatch(data: unknown): DurableIngressBatchRecord {
  const parsed = deserializeValue(data) as DurableIngressBatchRecord;
  return {
    ...parsed,
    receivedAt: new Date((parsed as WebhookBatchResult).receivedAt)
  };
}
