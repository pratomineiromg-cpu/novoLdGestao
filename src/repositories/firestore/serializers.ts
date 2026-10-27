import { Timestamp, FieldValue } from 'firebase/firestore';

export function toFirestoreDate(date: Date | undefined): Timestamp | null {
  if (!date) return null;
  return Timestamp.fromDate(date);
}

export function fromFirestoreDate(timestamp: any): Date {
  if (!timestamp) return new Date();
  if (timestamp instanceof Timestamp) {
    return timestamp.toDate();
  }
  if (timestamp.toDate && typeof timestamp.toDate === 'function') {
    return timestamp.toDate();
  }
  if (timestamp.seconds !== undefined) {
      return new Timestamp(timestamp.seconds, timestamp.nanoseconds).toDate();
  }
  return new Date(timestamp);
}

export function cleanForFirestore(obj: any): any {
  if (obj === null || obj === undefined) return null;
  
  if (obj instanceof Date) {
    return Timestamp.fromDate(obj);
  }

  // Preserve Firestore Sentinels (serverTimestamp(), deleteField(), etc.)
  if (obj instanceof FieldValue) {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => cleanForFirestore(item));
  }
  
  if (typeof obj === 'object') {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) {
        cleaned[key] = cleanForFirestore(value);
      }
    }
    return cleaned;
  }
  
  return obj;
}

export function fromFirestore(data: any): any {
  if (data === null || data === undefined) return null;

  if (data instanceof Timestamp || (data.seconds !== undefined && data.nanoseconds !== undefined)) {
    return fromFirestoreDate(data);
  }

  if (Array.isArray(data)) {
    return data.map(item => fromFirestore(item));
  }

  if (typeof data === 'object') {
    const parsed: any = {};
    for (const [key, value] of Object.entries(data)) {
      parsed[key] = fromFirestore(value);
    }
    return parsed;
  }

  return data;
}
