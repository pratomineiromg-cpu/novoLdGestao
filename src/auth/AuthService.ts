import { signInWithEmailAndPassword, signOut as firebaseSignOut, onAuthStateChanged, User } from 'firebase/auth';
import { auth } from '../firebase/firebase';
import { AuthenticatedUser } from './types';

const mapUser = (user: User | null): AuthenticatedUser | undefined => {
  if (!user) return undefined;
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
  };
};

export const mapAuthError = (error: any): string => {
  const code = error?.code;
  
  if (code === 'auth/network-request-failed') {
    return 'Não foi possível conectar ao serviço de autenticação. Verifique sua conexão e tente novamente.';
  }
  
  if (code === 'auth/too-many-requests') {
    return 'Muitas tentativas foram realizadas. Aguarde um momento e tente novamente.';
  }
  
  if (
    code === 'auth/user-not-found' || 
    code === 'auth/wrong-password' || 
    code === 'auth/invalid-credential' ||
    code === 'auth/invalid-email'
  ) {
    return 'E-mail ou senha inválidos.';
  }

  return 'Não foi possível realizar o login. Tente novamente.';
};

export const AuthService = {
  signIn: async (email: string, password: string): Promise<void> => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      throw new Error(mapAuthError(error));
    }
  },

  signOut: async (): Promise<void> => {
    await firebaseSignOut(auth);
  },

  subscribeToAuthState: (callback: (user: AuthenticatedUser | undefined) => void): (() => void) => {
    return onAuthStateChanged(auth, (user) => {
      callback(mapUser(user));
    });
  },

  getCurrentUser: (): AuthenticatedUser | undefined => {
    return mapUser(auth.currentUser);
  }
};
