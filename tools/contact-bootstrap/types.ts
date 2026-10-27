import { Contact } from '../../src/domain/types';

export interface BootstrapManifest {
  projectId: string;
  tenantId: string;
  operationId: string;
  contacts: RawBootstrapContact[];
}

export interface RawBootstrapContact extends Omit<Contact, 'createdAt' | 'updatedAt'> {
  createdAt: string;
  updatedAt: string;
}

export interface DocumentOperation {
  currentDocument: {
    exists: boolean;
  };
  update: {
    name: string;
    fields: Record<string, any>;
  };
}

export interface PlanFile {
  writes: DocumentOperation[];
}
