import { initializeApp, getApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

// Your web app's Firebase configuration
const env = typeof import.meta !== 'undefined' ? (import.meta as any).env : undefined;
const firebaseConfig = {
  apiKey: env?.VITE_FIREBASE_API_KEY || "AIzaSyCzmLDq40GGCjRvQrSMqA2SdP9Hy93f3n0",
  authDomain: env?.VITE_FIREBASE_AUTH_DOMAIN || "lidacomzap-gestao-inteligente.firebaseapp.com",
  projectId: env?.VITE_FIREBASE_PROJECT_ID || "lidacomzap-gestao-inteligente",
  storageBucket: env?.VITE_FIREBASE_STORAGE_BUCKET || "lidacomzap-gestao-inteligente.firebasestorage.app",
  messagingSenderId: env?.VITE_FIREBASE_MESSAGING_SENDER_ID || "446483877373",
  appId: env?.VITE_FIREBASE_APP_ID || "1:446483877373:web:578e5efaa8a44643c89d94"
};

// Initialize Firebase securely preventing duplicate initialization
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Use the default database
const db = getFirestore(app, "(default)");
const auth = getAuth(app);

export { app, db, auth };
