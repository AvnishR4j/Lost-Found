import { auth, db } from "./firebase.js";
import { collection, addDoc, getDocs, deleteDoc, doc, getDoc, updateDoc, serverTimestamp, query, orderBy, where, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const CLOUDINARY_CLOUD = "dr9detyn6";
const CLOUDINARY_PRESET = "lost_found";

function compressImage(file, maxWidth = 1024, quality = 0.75) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement("canvas");
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(resolve, "image/jpeg", quality);
    };
    img.src = url;
  });
}

async function uploadToCloudinary(file) {
  const compressed = await compressImage(file);
  const form = new FormData();
  form.append("file", compressed, "photo.jpg");
  form.append("upload_preset", CLOUDINARY_PRESET);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/image/upload`, { method: "POST", body: form });
  if (!res.ok) { const err = await res.json(); throw new Error(err.error?.message || "Upload failed"); }
  const data = await res.json();
  return data.secure_url;
}

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
  // Set avatar initials
  if (user.displayName) {
    const parts = user.displayName.trim().split(/\s+/);
    const initials = parts.length >= 2
      ? parts[0][0] + parts[parts.length - 1][0]
      : parts[0].slice(0, 2);
    const avatarEl = $("userAvatar");
    if (avatarEl) avatarEl.textContent = initials.toUpperCase();
  }
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

  const lostNotif = { ...baseNotif, userId: lostItem.uid, userEmail: lostItem.email, type: "match_found", title: "Potential Match Found!", message: `Your lost "${lostItem.title}" may match a found item "${foundItem.title}" near "${foundItem.location}".` };
  await addDoc(collection(db, "notifications"), lostNotif);
  if (user?.uid === lostItem.uid) showPushNotification(lostNotif.title, lostNotif.message);

  const foundNotif = { ...baseNotif, userId: foundItem.uid, userEmail: foundItem.email, type: "match_found", title: "Someone may be looking for this!", message: `Your found "${foundItem.title}" may belong to someone who lost "${lostItem.title}".` };
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
  msg.style.color = '#f87171';
  msg.innerText = "";

  if (!title || !description || !location || !phone) return msg.innerText = "Please fill all fields";
  if (!/^\d{10}$/.test(phone)) return msg.innerText = "Phone number must be 10 digits";

  const user = auth.currentUser;
  if (!user) return msg.innerText = "Session expired. Please login again.";

  let imageUrl = null;
  const photoFile = $("photo")?.files?.[0];
  if (photoFile) {
    msg.style.color = '#f59e0b';
    msg.innerText = "Uploading photo…";
    try {
      imageUrl = await uploadToCloudinary(photoFile);
    } catch(e) {
      return msg.innerText = "Photo upload failed. Try a smaller image or skip the photo.";
    }
  }

  const docRef = await addDoc(collection(db, "items"), { type, category, title, description, location, phone, imageUrl, email: user.email, uid: user.uid, status: "open", createdAt: serverTimestamp(), expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000 });

  const matchCount = await findMatches({ id: docRef.id, type, category, title, description, location, phone, email: user.email, uid: user.uid });
  msg.style.color = '#86efac';
  msg.innerText = matchCount > 0 ? `Item posted! Found ${matchCount} potential match${matchCount > 1 ? 'es' : ''}!` : "Item posted! We'll notify you if we find matches.";

  ["title", "description", "location", "phone"].forEach(id => $(id).value = "");
  if ($("photo")) { $("photo").value = ""; const prev = $("photoPreview"); if (prev) { prev.src = ""; prev.classList.add("hidden"); } }
  // Reset category pills
  document.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
  $("category").value = "ID Card";

  await loadItems();
};

// Load Items
async function loadItems() {
  const itemsDiv = $("items");
  itemsDiv.innerHTML = "";
  const snapshot = await getDocs(query(collection(db, "items"), orderBy("createdAt", "desc")));
  const user = auth.currentUser;

  if (snapshot.empty) {
    itemsDiv.innerHTML = '<div class="items-empty"><span class="icon">📭</span>No items posted yet.<br>Be the first to report one!</div>';
    if (typeof filterItems === 'function') filterItems();
    return;
  }

  let delay = 0;
  for (const docSnap of snapshot.docs) {
    const item = docSnap.data(), id = docSnap.id;
    if (item.expiresAt && Date.now() > item.expiresAt) { await deleteDoc(doc(db, "items", id)); continue; }

    const initials = item.email ? item.email.slice(0, 2).toUpperCase() : '??';
    const timeStr = item.createdAt?.toDate ? timeAgo(item.createdAt.toDate()) : 'Just now';

    const div = document.createElement("div");
    div.className = "item-card";
    div.dataset.type = item.type;
    div.style.animationDelay = delay + 'ms';
    div.innerHTML = `
      <div class="card-header">
        <div class="avatar-sm">${initials}</div>
        <div class="card-meta">
          <div class="tag-row">
            <span class="type-tag ${item.type}">${item.type === 'lost' ? '✕' : '✓'} ${item.type}</span>
            <span class="card-time">${timeStr}</span>
          </div>
          <div class="card-title">${escHtml(item.title)}</div>
        </div>
      </div>
      <p class="card-body">${escHtml(item.description)}</p>
      ${item.imageUrl ? `<img src="${item.imageUrl}" alt="Item photo" style="max-height:200px;width:100%;object-fit:cover;border-radius:10px;margin-bottom:8px;border:1px solid rgba(255,255,255,0.1)" loading="lazy" />` : ''}
      <div class="card-footer">
        <div class="card-location"><span>📍</span><span>${escHtml(item.location)}</span></div>
        <div class="card-actions">
          <a href="tel:${escHtml(item.phone)}" class="btn-contact">Contact</a>
          ${user && (user.uid === item.uid || isAdmin(user)) ? `<button onclick="openResolveModal('${id}')" class="btn-resolve">Resolve</button>` : ''}
        </div>
      </div>`;
    itemsDiv.appendChild(div);
    delay += 60;
  }

  // Trigger filter
  if (typeof filterItems === 'function') filterItems();
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function timeAgo(date) {
  const secs = Math.floor((Date.now() - date) / 1000);
  if (secs < 60) return 'Just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days === 1 ? 'Yesterday' : days + 'd ago';
}

// Resolve Modal
window.openResolveModal = id => { resolveItemId = id; $("resolveModal").classList.remove("hidden"); };
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

  badge.classList.toggle("visible", unread > 0);

  if (notifications.length === 0) {
    list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
    return;
  }

  list.innerHTML = notifications.map(n => `
    <div class="notif-item ${n.read ? 'read' : 'unread'}" onclick="openMatchDetails('${n.id}', '${n.lostItemId}', '${n.foundItemId}', ${n.matchScore})">
      <span class="icon">${n.read ? '📋' : '🎉'}</span>
      <div class="content">
        <div class="title">${escHtml(n.title)}</div>
        <div class="msg">${escHtml(n.message)}</div>
        <span class="score-badge">${n.matchScore}% match</span>
      </div>
    </div>`).join('');
}

// Use .open class for notification dropdown (defined in HTML script, override here)
window.toggleNotifications = () => {
  const dd = $("notifDropdown");
  const btn = $("notifBellBtn");
  dd.classList.toggle("open");
  btn.classList.toggle("active", dd.classList.contains("open"));
};

document.addEventListener("click", e => {
  const dd = $("notifDropdown"), btn = $("notifBellBtn");
  if (dd && btn && !dd.contains(e.target) && !btn.contains(e.target)) {
    dd.classList.remove("open");
    btn.classList.remove("active");
  }
});

// Match Details Modal
window.openMatchDetails = async (notifId, lostItemId, foundItemId, matchScore) => {
  await updateDoc(doc(db, "notifications", notifId), { read: true });
  $("notifDropdown")?.classList.remove("open");
  $("notifBellBtn")?.classList.remove("active");

  const [lostDoc, foundDoc] = await Promise.all([getDoc(doc(db, "items", lostItemId)), getDoc(doc(db, "items", foundItemId))]);
  const lostItem = lostDoc.exists() ? { id: lostDoc.id, ...lostDoc.data() } : null;
  const foundItem = foundDoc.exists() ? { id: foundDoc.id, ...foundDoc.data() } : null;

  if (!lostItem || !foundItem) return alert("One or both items no longer exist.");
  currentMatchData = { lostItem, foundItem, matchScore };

  // Build match confidence tags
  const tags = [];
  if (lostItem.category === foundItem.category) tags.push('Same category');
  if (normalizeLocation(lostItem.location) && normalizeLocation(foundItem.location) &&
      (normalizeLocation(lostItem.location).includes(normalizeLocation(foundItem.location)) ||
       normalizeLocation(foundItem.location).includes(normalizeLocation(lostItem.location)))) tags.push('Similar location');
  if (tags.length < 3) tags.push('Keyword match');

  $("matchContent").innerHTML = `
    <div class="match-score-hero">
      <div class="score-num">${matchScore}%</div>
      <div class="score-label">match confidence</div>
      <div class="match-tags">${tags.map(t => `<span class="match-tag">${t}</span>`).join('')}</div>
    </div>

    <div class="match-item-label lost">Your lost item</div>
    <div class="match-item-card lost-card">
      <div class="match-item-title">${escHtml(lostItem.title)}</div>
      <div class="match-item-desc">${escHtml(lostItem.description)}</div>
      <div class="match-item-loc">📍 ${escHtml(lostItem.location)}</div>
    </div>

    <div class="match-arrow">&#8596;</div>

    <div class="match-item-label found">Potential match</div>
    <div class="match-item-card found-card">
      <div class="match-item-title">${escHtml(foundItem.title)}</div>
      <div class="match-item-desc">${escHtml(foundItem.description)}</div>
      <div class="match-item-loc">📍 ${escHtml(foundItem.location)}</div>
    </div>`;

  $("matchModal").classList.remove("hidden");
};

window.closeMatchModal = () => { $("matchModal").classList.add("hidden"); currentMatchData = null; };
window.viewMatchedItem = () => { if (currentMatchData?.foundItem?.phone) window.open(`tel:${currentMatchData.foundItem.phone}`, "_self"); closeMatchModal(); };
window.logout = async () => { await signOut(auth); window.location.replace("index.html"); };
