import { doc, getDoc, Timestamp } from 'firebase/firestore';
import { db } from '../firebase/firebase';
import { COLLECTIONS, userDocumentId } from '../repositories/firestore/schema';
import { AppUserProfile, AppUserRole } from './types';

const VALID_ROLES: AppUserRole[] = ['ADMIN', 'ATENDIMENTO', 'CAIXA', 'COZINHA'];

export const validateAndMapUserProfile = (data: any, uid: string): AppUserProfile | null => {
  if (!data || typeof data !== 'object') return null;
  if (data.uid !== uid) return null;
  if (typeof data.active !== 'boolean') return null;
  if (!VALID_ROLES.includes(data.role as AppUserRole)) return null;
  if (typeof data.email !== 'string') return null;
  if (typeof data.name !== 'string') return null;

  if (
    !data.createdAt ||
    !(data.createdAt instanceof Timestamp || (typeof data.createdAt?.toDate === 'function'))
  ) {
    return null;
  }

  if (
    !data.updatedAt ||
    !(data.updatedAt instanceof Timestamp || (typeof data.updatedAt?.toDate === 'function'))
  ) {
    return null;
  }

  const createdAt = data.createdAt.toDate();
  const updatedAt = data.updatedAt.toDate();

  if (!(createdAt instanceof Date) || isNaN(createdAt.getTime())) return null;
  if (!(updatedAt instanceof Date) || isNaN(updatedAt.getTime())) return null;

  return {
    uid: data.uid,
    email: data.email,
    name: data.name,
    active: data.active,
    role: data.role as AppUserRole,
    createdAt,
    updatedAt
  };
};

export const UserProfileService = {
  getUserProfile: async (uid: string): Promise<AppUserProfile | null> => {
    try {
      const docRef = doc(db, COLLECTIONS.USERS, userDocumentId(uid));
      const docSnap = await getDoc(docRef);

      if (!docSnap.exists()) {
        return null;
      }

      return validateAndMapUserProfile(docSnap.data(), uid);
    } catch (e) {
      return null;
    }
  }
};

