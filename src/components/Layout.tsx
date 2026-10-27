import React, { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { AuthService } from '../auth/AuthService';
import { useAuth } from '../auth/AuthProvider';
import { isReadOnlyMode } from '../config/dataSource';

export const Layout = () => {
  const { profile } = useAuth();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const readOnly = isReadOnlyMode();

  const handleSignOut = async () => {
    if (isSigningOut) return;

    setIsSigningOut(true);
    setSignOutError(null);

    try {
      await AuthService.signOut();
    } catch {
      setSignOutError('Não foi possível encerrar a sessão. Tente novamente.');
      setIsSigningOut(false);
    }
  };

  const initial = profile?.name ? profile.name.charAt(0).toUpperCase() : 'A';

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden text-slate-900 font-sans">
      <Sidebar />
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        <header className="h-16 bg-white border-b border-slate-200 flex items-center px-6 justify-between flex-shrink-0">
          <div className="flex items-center space-x-3">
            <h1 className="text-lg font-semibold text-slate-800">Operação Piloto</h1>
            {readOnly && (
              <span className="text-xs font-medium px-2.5 py-1 bg-amber-50 text-amber-800 border border-amber-200 rounded-md">
                Firestore — Somente leitura
              </span>
            )}
          </div>
          <div className="flex items-center space-x-4">
            <div className="text-sm text-slate-500"><span className="font-medium text-slate-700">Restaurante Prato Mineiro</span></div>
            <div className="flex items-center">
              {signOutError && <span className="text-red-500 text-xs mr-2">{signOutError}</span>}
              <button 
                onClick={handleSignOut}
                disabled={isSigningOut}
                className="text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors disabled:opacity-50"
              >
                {isSigningOut ? 'Saindo...' : 'Sair'}
              </button>
            </div>
            <div className="h-8 w-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold border border-indigo-200" title={profile?.name || ''}>
              {initial}
            </div>
          </div>
        </header>
        <main className="flex-1 overflow-auto relative">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
