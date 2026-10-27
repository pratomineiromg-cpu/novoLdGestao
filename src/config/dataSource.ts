export type DataSourceMode = 'MOCK' | 'FIRESTORE_READONLY' | 'FIRESTORE';

export function parseDataSourceMode(value: string | undefined): DataSourceMode {
  if (!value || value.trim() === '') {
    return 'MOCK';
  }
  const normalized = value.trim();
  if (normalized === 'MOCK') return 'MOCK';
  if (normalized === 'FIRESTORE_READONLY') return 'FIRESTORE_READONLY';
  if (normalized === 'FIRESTORE') return 'FIRESTORE';
  throw new Error(`Invalid DATA_SOURCE_MODE: "${value}". Expected MOCK, FIRESTORE_READONLY, or FIRESTORE.`);
}

export function getDataSourceMode(): DataSourceMode {
  let raw: string | undefined;
  if (typeof process !== 'undefined' && process.env && process.env.VITE_DATA_SOURCE_MODE !== undefined) {
    raw = process.env.VITE_DATA_SOURCE_MODE;
  } else if (typeof import.meta !== 'undefined' && (import.meta as any).env) {
    raw = (import.meta as any).env.VITE_DATA_SOURCE_MODE;
  }
  return parseDataSourceMode(raw);
}

export function isReadOnlyMode(): boolean {
  return getDataSourceMode() === 'FIRESTORE_READONLY';
}
