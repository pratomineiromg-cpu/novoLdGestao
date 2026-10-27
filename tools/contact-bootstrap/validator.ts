import { validateContact } from '../../src/repositories/firestore/readValidators';
import { BootstrapManifest } from './types';
import { Contact } from '../../src/domain/types';

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

function getDaysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) {
    return 30;
  }
  return 31;
}

const STRICT_ISO_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

export function canonicalPhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

export function isValidFirestoreDocumentId(id: string): boolean {
  if (!id || typeof id !== 'string' || id.trim() === '') return false;
  if (id === '.' || id === '..') return false;
  if (id.includes('/')) return false;
  return true;
}

export function parseStrictIsoTimestamp(value: any, fieldName: string, contactId: string): Date {
  if (typeof value !== 'string') {
    throw new Error(`Contact ${contactId} has non-ISO ${fieldName} timestamp: "${value}". Must be ISO-8601 with date, time, and timezone (e.g. 2026-09-01T12:00:00Z).`);
  }

  const match = value.match(STRICT_ISO_REGEX);
  if (!match) {
    throw new Error(`Contact ${contactId} has non-ISO ${fieldName} timestamp: "${value}". Must be ISO-8601 with date, time, and timezone (e.g. 2026-09-01T12:00:00Z).`);
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = parseInt(match[6], 10);
  const timezone = match[8];

  if (month < 1 || month > 12) {
    throw new Error(`Contact ${contactId} has invalid calendar month ${month} in ${fieldName} timestamp: "${value}".`);
  }

  const maxDays = getDaysInMonth(year, month);
  if (day < 1 || day > maxDays) {
    throw new Error(`Contact ${contactId} has impossible calendar date day ${day} for month ${month}/${year} in ${fieldName} timestamp: "${value}".`);
  }

  if (hour < 0 || hour > 23) {
    throw new Error(`Contact ${contactId} has invalid hour ${hour} in ${fieldName} timestamp: "${value}".`);
  }

  if (minute < 0 || minute > 59) {
    throw new Error(`Contact ${contactId} has invalid minute ${minute} in ${fieldName} timestamp: "${value}".`);
  }

  if (second < 0 || second > 59) {
    throw new Error(`Contact ${contactId} has invalid second ${second} in ${fieldName} timestamp: "${value}".`);
  }

  if (timezone !== 'Z') {
    const tzHour = parseInt(timezone.slice(1, 3), 10);
    const tzMin = parseInt(timezone.slice(4, 6), 10);
    if (tzHour < 0 || tzHour > 23 || tzMin < 0 || tzMin > 59) {
      throw new Error(`Contact ${contactId} has invalid timezone offset in ${fieldName} timestamp: "${value}".`);
    }
  }

  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new Error(`Contact ${contactId} has invalid ${fieldName} timestamp value: "${value}".`);
  }
  return date;
}

export function validateManifest(manifest: BootstrapManifest): Contact[] {
  if (!manifest.operationId || typeof manifest.operationId !== 'string' || manifest.operationId.trim().length === 0) {
    throw new Error('Manifest must have a non-empty string "operationId".');
  }

  if (manifest.projectId !== 'lidacomzap-gestao-inteligente') {
    throw new Error('Invalid projectId. Must be "lidacomzap-gestao-inteligente".');
  }

  if (manifest.tenantId !== 't-pratomineiro') {
    throw new Error('Invalid tenantId. Must be "t-pratomineiro".');
  }

  if (!manifest.contacts || !Array.isArray(manifest.contacts)) {
    throw new Error('Manifest must contain a "contacts" array.');
  }

  const validatedContacts: Contact[] = [];
  const idSet = new Set<string>();
  const phoneToContactId = new Map<string, string>();

  for (let i = 0; i < manifest.contacts.length; i++) {
    const raw = manifest.contacts[i];
    
    if (!isValidFirestoreDocumentId(raw.id)) {
      throw new Error(`Contact at index ${i} has unsafe or invalid Firestore document id "${raw.id}". Cannot contain "/" or equal "." or "..".`);
    }

    if (idSet.has(raw.id)) {
      throw new Error(`Duplicate contact ID found: ${raw.id}`);
    }
    idSet.add(raw.id);

    if (raw.tenantId !== manifest.tenantId) {
      throw new Error(`Contact ${raw.id} tenantId "${raw.tenantId}" does not match manifest tenantId "${manifest.tenantId}".`);
    }

    const canon = canonicalPhone(raw.phone || '');
    if (canon === '') {
      throw new Error(`Contact ${raw.id} has an invalid or empty phone.`);
    }
    const existingContactId = phoneToContactId.get(canon);
    if (existingContactId) {
      throw new Error(`Duplicate canonical phone detected for contact IDs "${existingContactId}" and "${raw.id}".`);
    }
    phoneToContactId.set(canon, raw.id);

    // Convert dates strictly
    const createdAt = parseStrictIsoTimestamp(raw.createdAt, 'createdAt', raw.id);
    const updatedAt = parseStrictIsoTimestamp(raw.updatedAt, 'updatedAt', raw.id);

    const domainContact: Contact = {
      ...raw,
      createdAt,
      updatedAt,
    };

    try {
      validateContact(domainContact);
    } catch (e: any) {
      throw new Error(`Contact ${raw.id} failed validation: ${e.message}`);
    }

    validatedContacts.push(domainContact);
  }

  return validatedContacts;
}
