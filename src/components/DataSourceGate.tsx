import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { getDataSourceMode } from '../config/dataSource';
import { repository } from '../repositories';
import { FirestoreReadOnlyRepository, HydrationStatus } from '../repositories/FirestoreReadOnlyRepository';

export const DataSourceGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const mode = getDataSourceMode();

  if (mode === 'MOCK') {
    return <>{children}</>;
  }

  if (mode === 'FIRESTORE') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md bg-white p-8 rounded-xl border border-red-200 shadow-sm text-center">
          <h2 className="text-lg font-bold text-red-600 mb-2">Modo não permitido</h2>
          <p className="text-sm text-slate-600">Firestore write mode is not enabled.</p>
        </div>
      </div>
    );
  }

  // FIRESTORE_READONLY Mode
  const readOnlyRepo = repository as FirestoreReadOnlyRepository;

  const hydrationStatus: HydrationStatus = useSyncExternalStore(
    readOnlyRepo.subscribe ? readOnlyRepo.subscribe.bind(readOnlyRepo) : () => () => {},
    () => (typeof readOnlyRepo.getHydrationStatus === 'function' ? readOnlyRepo.getHydrationStatus() : 'ready')
  );

  useEffect(() => {
    if (typeof readOnlyRepo.getHydrationStatus === 'function') {
      if (readOnlyRepo.getHydrationStatus() === 'idle') {
        readOnlyRepo.hydrate();
      }
    }
  }, [readOnlyRepo]);

  if (hydrationStatus === 'idle' || hydrationStatus === 'loading') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 text-slate-600 p-6">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mb-4" />
        <p className="text-sm font-medium text-slate-700">Carregando dados operacionais...</p>
      </div>
    );
  }

  if (hydrationStatus === 'error') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 p-6 text-center">
        <div className="max-w-md bg-white p-8 rounded-xl border border-slate-200 shadow-sm">
          <div className="w-12 h-12 bg-red-50 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4 font-bold text-xl">
            !
          </div>
          <h2 className="text-lg font-bold text-slate-800 mb-2">Não foi possível carregar os dados operacionais.</h2>
          <p className="text-sm text-slate-500 mb-6">
            Ocorreu uma falha ao sincronizar com o banco de dados em modo somente leitura.
          </p>
          <button
            onClick={() => readOnlyRepo.hydrate()}
            className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg shadow-sm transition-colors cursor-pointer"
          >
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};
