import React from 'react';
import { useAuth } from '../auth/AuthProvider';
import { AuthState } from '../auth/types';
import { LoginView } from '../views/LoginView';
import { UnauthorizedView } from '../views/UnauthorizedView';

export type AuthGateDecision = 'LOADING' | 'UNAUTHENTICATED' | 'UNAUTHORIZED' | 'AUTHORIZED';

export function resolveAuthGateState(status: AuthState['status']): AuthGateDecision {
  if (status === 'loading' || status === 'authorizing') {
    return 'LOADING';
  }
  if (status === 'unauthenticated') {
    return 'UNAUTHENTICATED';
  }
  if (status === 'unauthorized') {
    return 'UNAUTHORIZED';
  }
  if (status === 'authorized') {
    return 'AUTHORIZED';
  }
  return 'UNAUTHENTICATED';
}

export function isAuthorizedToAccessContent(status: AuthState['status']): boolean {
  return resolveAuthGateState(status) === 'AUTHORIZED';
}

export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { status } = useAuth();
  const decision = resolveAuthGateState(status);

  switch (decision) {
    case 'LOADING':
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <div className="text-gray-500">Carregando...</div>
        </div>
      );
    case 'UNAUTHENTICATED':
      return <LoginView />;
    case 'UNAUTHORIZED':
      return <UnauthorizedView />;
    case 'AUTHORIZED':
      return <>{children}</>;
  }
};
