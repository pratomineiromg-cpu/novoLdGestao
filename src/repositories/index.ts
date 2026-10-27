import { AppRepository } from './IRepository';
import { mockRepository } from './MockRepository';
import { FirestoreReadOnlyRepository } from './FirestoreReadOnlyRepository';
import { getDataSourceMode, DataSourceMode } from '../config/dataSource';

export function createRepository(modeOverride?: DataSourceMode): AppRepository {
  const mode = modeOverride || getDataSourceMode();
  switch (mode) {
    case 'MOCK':
      return mockRepository;
    case 'FIRESTORE_READONLY':
      return new FirestoreReadOnlyRepository();
    case 'FIRESTORE':
      throw new Error('Firestore write mode is not enabled.');
    default:
      throw new Error(`Unsupported data source mode: ${mode}`);
  }
}

// Default export uses the configured data source mode
export const repository: AppRepository = createRepository();

