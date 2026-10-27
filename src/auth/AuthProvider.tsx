import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AuthState, AuthenticatedUser } from './types';
import { AuthService } from './AuthService';
import { UserProfileService } from './UserProfileService';

const AuthContext = createContext<AuthState>({
  status: 'loading'
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authState, setAuthState] = useState<AuthState>({
    status: 'loading'
  });
  const authGenerationRef = useRef(0);

  useEffect(() => {
    const unsubscribe = AuthService.subscribeToAuthState(async (user) => {
      const generation = ++authGenerationRef.current;

      if (user) {
        setAuthState({
          status: 'authorizing',
          user
        });
        
        try {
          const profile = await UserProfileService.getUserProfile(user.uid);
          
          if (generation !== authGenerationRef.current) {
            return;
          }

          if (profile && profile.active) {
            setAuthState({
              status: 'authorized',
              user,
              profile
            });
          } else {
            setAuthState({
              status: 'unauthorized',
              user,
              error: !profile ? 'Perfil não encontrado.' : 'Perfil inativo.'
            });
          }
        } catch (err) {
          if (generation !== authGenerationRef.current) {
            return;
          }

          setAuthState({
            status: 'unauthorized',
            user,
            error: 'Erro ao validar perfil.'
          });
        }
      } else {
        setAuthState({
          status: 'unauthenticated'
        });
      }
    });

    return () => {
      authGenerationRef.current++;
      unsubscribe();
    };
  }, []);

  return (
    <AuthContext.Provider value={authState}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
