import { auth, db } from "./firebase.js";

import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

import {
  doc,
  setDoc,
  getDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const loginBtn = document.getElementById("loginBtn");
const msg = document.getElementById("msg");

// Check if user is already logged in
onAuthStateChanged(auth, (user) => {
  if (user && user.email.endsWith("@thapar.edu")) {
    window.location.replace("dashboard.html");
  }
});

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

loginBtn.onclick = async () => {
  msg.innerText = "";

  try {
    const result = await signInWithPopup(auth, provider);
    const user = result.user;

    if (!user.email.endsWith("@thapar.edu")) {
      await signOut(auth);
      msg.innerText = "Only @thapar.edu Google accounts are allowed";
      return;
    }

    // Save user only once
    const userRef = doc(db, "users", user.uid);
    const snap = await getDoc(userRef);

    if (!snap.exists()) {
      await setDoc(userRef, {
        uid: user.uid,
        name: user.displayName,
        email: user.email,
        photo: user.photoURL,
        createdAt: serverTimestamp()
      });
    }

    // ✅ SINGLE redirect
    window.location.href = "dashboard.html";

  } catch (err) {
    console.error(err);

    if (err.code === "auth/popup-blocked") {
      msg.innerText = "Popup blocked. Please allow popups.";
    } else if (err.code === "auth/cancelled-popup-request") {
      msg.innerText = "Login cancelled.";
    } else {
      msg.innerText = "Google sign-in failed.";
    }
  }
};
