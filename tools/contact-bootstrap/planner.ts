import { Contact } from '../../src/domain/types';
import { COLLECTIONS } from '../../src/repositories/firestore/schema';
import { validateContact } from '../../src/repositories/firestore/readValidators';
import { isValidFirestoreDocumentId } from './validator';
import { PlanFile, DocumentOperation } from './types';

function encodeFirestoreValue(value: any): any {
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(encodeFirestoreValue)
      }
    };
  }
  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }
  
  throw new Error(`Unsupported type for value: ${JSON.stringify(value)}`);
}

export function generatePlan(projectId: string, tenantId: string, contacts: Contact[]): PlanFile {
  if (projectId !== 'lidacomzap-gestao-inteligente') {
    throw new Error('Invalid projectId in planner. Must be "lidacomzap-gestao-inteligente".');
  }
  if (tenantId !== 't-pratomineiro') {
    throw new Error('Invalid tenantId in planner. Must be "t-pratomineiro".');
  }

  const writes: DocumentOperation[] = contacts.map((contact, index) => {
    if (!contact || typeof contact !== 'object') {
      throw new Error(`Contact at index ${index} is not a valid object.`);
    }

    if (!isValidFirestoreDocumentId(contact.id)) {
      throw new Error(`Unsafe or invalid Firestore document id in planner: "${contact.id}".`);
    }

    if (contact.tenantId !== tenantId) {
      throw new Error(`Contact ${contact.id} tenantId "${contact.tenantId}" does not match planner tenantId "${tenantId}".`);
    }

    try {
      validateContact(contact);
    } catch (err: any) {
      throw new Error(`Contact ${contact.id} failed domain validation in planner: ${err.message}`);
    }

    const fields: Record<string, any> = {
      id: encodeFirestoreValue(contact.id),
      tenantId: encodeFirestoreValue(contact.tenantId),
      name: encodeFirestoreValue(contact.name),
      phone: encodeFirestoreValue(contact.phone),
      tags: encodeFirestoreValue(contact.tags),
      notes: encodeFirestoreValue(contact.notes),
      createdAt: encodeFirestoreValue(contact.createdAt),
      updatedAt: encodeFirestoreValue(contact.updatedAt),
    };

    if (contact.avatar !== undefined) {
      fields.avatar = encodeFirestoreValue(contact.avatar);
    }

    return {
      currentDocument: { exists: false },
      update: {
        name: `projects/${projectId}/databases/(default)/documents/${COLLECTIONS.CONTACTS}/${contact.id}`,
        fields
      }
    };
  });

  return { writes };
}

