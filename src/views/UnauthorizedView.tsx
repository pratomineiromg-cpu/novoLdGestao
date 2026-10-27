import React, { useState } from 'react';
import { AuthService } from '../auth/AuthService';

export const UnauthorizedView: React.FC = () => {
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    setError(null);
    try {
      await AuthService.signOut();
    } catch {
      setError('Não foi possível encerrar a sessão. Tente novamente.');
      setIsSigningOut(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
          LidacomZap Gestão Inteligente
        </h2>
        <div className="mt-8 bg-white py-8 px-4 shadow sm:rounded-lg sm:px-10 text-center">
          <h3 className="text-lg font-medium text-red-600 mb-4">Acesso não autorizado</h3>
          <p className="text-sm text-gray-600 mb-6">
            Sua conta está autenticada, mas não possui acesso ativo a esta operação.
          </p>
          {error && <p className="text-xs text-red-500 mb-4">{error}</p>}
          <button
            onClick={handleSignOut}
            disabled={isSigningOut}
            className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-slate-800 hover:bg-slate-900 focus:outline-none disabled:opacity-50"
          >
            {isSigningOut ? 'Saindo...' : 'Sair'}
          </button>
        </div>
      </div>
    </div>
  );
};
