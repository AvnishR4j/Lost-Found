import { auth, db } from "./firebase.js";
import { collection, addDoc, getDocs, deleteDoc, doc, getDoc, updateDoc, serverTimestamp, query, orderBy, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const ADMIN_EMAILS = ["admin@thapar.edu", "araj3_be24@thapar.edu"];
const MATCH_THRESHOLD = 50;
const WEIGHTS = { category: 40, location: 30, keywords: 30 };
const STOP_WORDS = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because', 'until', 'while', 'my', 'i', 'me', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they', 'them', 'his', 'her', 'its', 'their', 'this', 'that', 'these', 'those', 'lost', 'found', 'please', 'help', 'anyone', 'someone', 'near', 'around', 'today', 'yesterday', 'morning', 'evening', 'night', 'afternoon']);

let authResolved = false, resolveItemId = null, currentMatchData = null;
const isAdmin = u => u && ADMIN_EMAILS.includes(u.email);
const $ = id => document.getElementById(id);

// Auth Guard
onAuthStateChanged(auth, user => {
  if (authResolved) return;
  authResolved = true;
  if (!user) return window.location.replace("index.html");
  loadItems();
  loadNotifications(user.uid);
  requestNotificationPermission();
});

// Push Notification Functions
async function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

function showPushNotification(title, message) {
  if (Notification.permission !== "granted") return;
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.ready.then(reg => reg.showNotification(title, { body: message, icon: "./icon-192.png", vibrate: [200, 100, 200], tag: "match-notification", renotify: true }));
  } else {
    new Notification(title, { body: message, icon: "./icon-192.png" });
  }
}

// Matching Functions
const extractKeywords = text => !text ? [] : text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w)).slice(0, 20);
const normalizeLocation = loc => loc?.toLowerCase().trim() || '';

function calculateMatchScore(item1, item2) {
  let score = 0;
  const details = { category: false, location: false, keywordOverlap: 0, matchedKeywords: [] };

  if (item1.category && item1.category === item2.category) { score += WEIGHTS.category; details.category = true; }

  const [loc1, loc2] = [normalizeLocation(item1.location), normalizeLocation(item2.location)];
  if (loc1 && loc2) {
    if (loc1 === loc2) { score += WEIGHTS.location; details.location = true; }
    else if (loc1.includes(loc2) || loc2.includes(loc1)) { score += WEIGHTS.location * 0.7; details.location = true; }
    else if (loc1.split(/\s+/).filter(w => loc2.split(/\s+/).includes(w) && w.length > 2).length > 0) { score += WEIGHTS.location * 0.5; details.location = true; }
  }

  const [kw1, kw2] = [new Set(extractKeywords(`${item1.title} ${item1.description}`)), new Set(extractKeywords(`${item2.title} ${item2.description}`))];
  const intersection = [...kw1].filter(k => kw2.has(k));
  if (intersection.length > 0) {
    score += ((intersection.length / new Set([...kw1, ...kw2]).size) + Math.min(intersection.length / 5, 1) * 0.3) * WEIGHTS.keywords;
    details.keywordOverlap = intersection.length;
    details.matchedKeywords = intersection.slice(0, 5);
  }

  return { score: Math.round(Math.min(score, 100)), matchDetails: details };
}

async function matchExists(lostId, foundId) {
  return !(await getDocs(query(collection(db, "matches"), where("lostItemId", "==", lostId), where("foundItemId", "==", foundId)))).empty;
}

async function createMatchNotification(lostItem, foundItem, score, matchDetails) {
  if (lostItem.uid === foundItem.uid) return null;
  const user = auth.currentUser;

  const baseNotif = { lostItemId: lostItem.id, foundItemId: foundItem.id, matchScore: score, matchDetails, read: false, createdAt: serverTimestamp() };

  const lostNotif = { ...baseNotif, userId: lostItem.uid, userEmail: lostItem.email, type: "match_found", title: "🎉 Potential Match Found!", message: `Your lost "${lostItem.title}" may match a found item "${foundItem.title}" near "${foundItem.location}".` };
  await addDoc(collection(db, "notifications"), lostNotif);
  if (user?.uid === lostItem.uid) showPushNotification(lostNotif.title, lostNotif.message);

  const foundNotif = { ...baseNotif, userId: foundItem.uid, userEmail: foundItem.email, type: "match_found", title: "🎉 Someone may be looking for this!", message: `Your found "${foundItem.title}" may belong to someone who lost "${lostItem.title}".` };
  await addDoc(collection(db, "notifications"), foundNotif);
  if (user?.uid === foundItem.uid) showPushNotification(foundNotif.title, foundNotif.message);

  await addDoc(collection(db, "matches"), { lostItemId: lostItem.id, foundItemId: foundItem.id, score, matchedOn: matchDetails, createdAt: serverTimestamp(), status: "pending" });
  return { lostNotif, foundNotif };
}

async function findMatches(newItem) {
  const snapshot = await getDocs(query(collection(db, "items"), where("type", "==", newItem.type === "lost" ? "found" : "lost"), where("status", "==", "open")));
  const now = Date.now();
  const matches = snapshot.docs.map(d => ({ item: { id: d.id, ...d.data() }, ...calculateMatchScore(newItem, d.data()) }))
    .filter(m => m.score >= MATCH_THRESHOLD && (!m.item.expiresAt || m.item.expiresAt >= now))
    .sort((a, b) => b.score - a.score).slice(0, 3);

  let count = 0;
  for (const m of matches) {
    const [lost, found] = newItem.type === "lost" ? [newItem, m.item] : [m.item, newItem];
    if (!(await matchExists(lost.id, found.id))) { await createMatchNotification(lost, found, m.score, m.matchDetails); count++; }
  }
  return count;
}

// Post Item
window.postItem = async () => {
  const [type, category, title, description, location, phone] = ["type", "category", "title", "description", "location", "phone"].map(id => $(id).value.trim());
  const msg = $("msg");
  msg.innerText = "";

  if (!title || !description || !location || !phone) return msg.innerText = "Please fill all fields";
  if (!/^\d{10}$/.test(phone)) return msg.innerText = "Phone number must be 10 digits";

  const user = auth.currentUser;
  if (!user) return msg.innerText = "Session expired. Please login again.";

  const docRef = await addDoc(collection(db, "items"), { type, category, title, description, location, phone, email: user.email, uid: user.uid, status: "open", createdAt: serverTimestamp(), expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000 });
  msg.innerText = "Item posted! Searching for matches...";

  const matchCount = await findMatches({ id: docRef.id, type, category, title, description, location, phone, email: user.email, uid: user.uid });
  msg.innerText = matchCount > 0 ? `✅ Item posted! Found ${matchCount} potential match${matchCount > 1 ? 'es' : ''}!` : "✅ Item posted successfully! We'll notify you if we find matches.";

  ["title", "description", "location", "phone"].forEach(id => $(id).value = "");
  await loadItems();
};

// Load Items
async function loadItems() {
  const itemsDiv = $("items");
  itemsDiv.innerHTML = "";
  const snapshot = await getDocs(query(collection(db, "items"), orderBy("createdAt", "desc")));
  const user = auth.currentUser;

  for (const docSnap of snapshot.docs) {
    const item = docSnap.data(), id = docSnap.id;
    if (item.expiresAt && Date.now() > item.expiresAt) { await deleteDoc(doc(db, "items", id)); continue; }

    const div = document.createElement("div");
    div.className = "p-5 rounded-2xl bg-white/10 backdrop-blur-xl border border-white/20";
    div.innerHTML = `
      <h3 class="text-xl font-semibold text-cyan-400">${item.title} <span class="text-sm text-gray-400">(${item.type})</span></h3>
      <p class="text-gray-300 mt-1">${item.description}</p>
      <p class="text-gray-400 mt-2">📍 ${item.location}</p>
      <div class="mt-4 flex flex-wrap gap-3">
        <a href="tel:${item.phone}" class="px-5 py-2 rounded-xl font-medium bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30 transition">📞 Contact</a>
        ${user && (user.uid === item.uid || isAdmin(user)) ? `<button onclick="openResolveModal('${id}')" class="px-5 py-2 rounded-xl font-medium bg-purple-500/20 text-purple-400 border border-purple-500/30 hover:bg-purple-500/30 transition">✅ Mark as Resolved</button>` : ''}
      </div>`;
    itemsDiv.appendChild(div);
  }
}

// Resolve Modal
window.openResolveModal = id => { resolveItemId = id; $("resolveModal").classList.remove("hidden"); $("resolveModal").classList.add("flex"); };
window.closeResolveModal = () => { resolveItemId = null; $("resolveModal").classList.add("hidden"); };
$("confirmResolveBtn").onclick = async () => { if (!resolveItemId) return; await deleteDoc(doc(db, "items", resolveItemId)); closeResolveModal(); loadItems(); };

// Notifications
function loadNotifications(userId) {
  onSnapshot(query(collection(db, "notifications"), where("userId", "==", userId), orderBy("createdAt", "desc")), snap => {
    renderNotifications(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

function renderNotifications(notifications) {
  const badge = $("notifBadge"), list = $("notifList");
  const unread = notifications.filter(n => !n.read).length;

  badge.textContent = unread > 9 ? "9+" : unread;
  badge.classList.toggle("hidden", unread === 0);

  if (notifications.length === 0) return list.innerHTML = '<p class="text-gray-500 text-sm text-center py-4">No notifications yet</p>';

  list.innerHTML = notifications.map(n => `
    <div class="p-3 rounded-xl mb-2 cursor-pointer transition ${n.read ? 'bg-white/5' : 'bg-purple-500/20 border border-purple-500/30'} hover:bg-white/10" onclick="openMatchDetails('${n.id}', '${n.lostItemId}', '${n.foundItemId}', ${n.matchScore})">
      <div class="flex items-start gap-3">
        <span class="text-2xl">${n.read ? '📋' : '🎉'}</span>
        <div class="flex-1 min-w-0">
          <p class="font-medium text-sm ${n.read ? 'text-gray-400' : 'text-white'}">${n.title}</p>
          <p class="text-xs text-gray-500 mt-1 truncate">${n.message}</p>
          <span class="text-xs px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-400 mt-2 inline-block">${n.matchScore}% match</span>
        </div>
      </div>
    </div>`).join('');
}

window.toggleNotifications = () => $("notifDropdown").classList.toggle("hidden");
document.addEventListener("click", e => { if (!$("notifDropdown").contains(e.target) && !$("notifBellBtn").contains(e.target)) $("notifDropdown").classList.add("hidden"); });

// Match Details Modal
window.openMatchDetails = async (notifId, lostItemId, foundItemId, matchScore) => {
  await updateDoc(doc(db, "notifications", notifId), { read: true });
  $("notifDropdown").classList.add("hidden");

  const [lostDoc, foundDoc] = await Promise.all([getDoc(doc(db, "items", lostItemId)), getDoc(doc(db, "items", foundItemId))]);
  const lostItem = lostDoc.exists() ? { id: lostDoc.id, ...lostDoc.data() } : null;
  const foundItem = foundDoc.exists() ? { id: foundDoc.id, ...foundDoc.data() } : null;

  if (!lostItem || !foundItem) return alert("One or both items no longer exist.");
  currentMatchData = { lostItem, foundItem, matchScore };

  $("matchContent").innerHTML = `
    <div class="bg-white/5 p-4 rounded-xl">
      <div class="flex items-center gap-2 mb-2"><span class="text-red-400">📍 LOST</span><span class="flex-1 text-sm text-gray-400">Your item</span></div>
      <h4 class="font-semibold text-white">${lostItem.title}</h4>
      <p class="text-sm text-gray-400 mt-1">${lostItem.description}</p>
      <p class="text-sm text-gray-500 mt-1">📍 ${lostItem.location}</p>
    </div>
    <div class="flex justify-center"><span class="px-4 py-2 rounded-full bg-gradient-to-r from-purple-600 to-cyan-500 text-white font-bold">${matchScore}% Match</span></div>
    <div class="bg-white/5 p-4 rounded-xl">
      <div class="flex items-center gap-2 mb-2"><span class="text-green-400">✅ FOUND</span><span class="flex-1 text-sm text-gray-400">Potential match</span></div>
      <h4 class="font-semibold text-white">${foundItem.title}</h4>
      <p class="text-sm text-gray-400 mt-1">${foundItem.description}</p>
      <p class="text-sm text-gray-500 mt-1">📍 ${foundItem.location}</p>
    </div>`;

  $("matchModal").classList.remove("hidden");
  $("matchModal").classList.add("flex");
};

window.closeMatchModal = () => { $("matchModal").classList.add("hidden"); currentMatchData = null; };
window.viewMatchedItem = () => { if (currentMatchData?.foundItem?.phone) window.open(`tel:${currentMatchData.foundItem.phone}`, "_self"); closeMatchModal(); };
window.logout = async () => { await signOut(auth); window.location.replace("index.html"); };
