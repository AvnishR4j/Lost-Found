// firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyDl-8SJZlhikZrOvmcxKB03kEQ77ESA9aI",
  authDomain: "student-hub-wqat4.firebaseapp.com",
  projectId: "student-hub-wqat4",
  storageBucket: "student-hub-wqat4.appspot.com",
  messagingSenderId: "627193676495",
  appId: "1:627193676495:web:23f3811b624dabd214adba"
};

const app = initializeApp(firebaseConfig);

// ✅ Persist login across app close / recents / restart
export const auth = getAuth(app);
await setPersistence(auth, browserLocalPersistence);

export const db = getFirestore(app);
export const storage = getStorage(app);
