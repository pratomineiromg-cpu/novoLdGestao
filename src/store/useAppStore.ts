import { useSyncExternalStore } from 'react';
import { repository } from '../repositories';
import { DatabaseState } from '../repositories/IRepository';

export const subscribeToRepository = (listener: () => void) => repository.subscribe(listener);
export const getRepositorySnapshot = () => repository.getState();

export const useAppStore = (): DatabaseState => {
  return useSyncExternalStore(
    subscribeToRepository,
    getRepositorySnapshot,
    getRepositorySnapshot
  );
};

