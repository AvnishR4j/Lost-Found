/**
 * Firebase Cloud Functions for Lost & Found Intelligent Matching
 * 
 * This module provides automatic matching between lost and found items
 * based on category, location, and keyword similarity.
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();

// ==================== CONFIGURATION ====================
const MATCH_THRESHOLD = 50;  // Minimum score to trigger notification (0-100)

const WEIGHTS = {
  category: 40,      // Highest priority - exact category match
  location: 30,      // Medium priority - location similarity  
  keywords: 30       // Keyword overlap from title + description
};

// ==================== UTILITY FUNCTIONS ====================

/**
 * Common stop words to filter out during keyword extraction
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'must', 'shall',
  'can', 'need', 'to', 'of', 'in', 'for', 'on', 'with', 'at',
  'by', 'from', 'as', 'into', 'through', 'during', 'before',
  'after', 'above', 'below', 'between', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'when', 'where',
  'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or',
  'because', 'until', 'while', 'my', 'i', 'me', 'we', 'our',
  'you', 'your', 'he', 'she', 'it', 'they', 'them', 'his', 'her',
  'its', 'their', 'this', 'that', 'these', 'those', 'lost', 'found',
  'please', 'help', 'anyone', 'someone', 'near', 'around', 'today',
  'yesterday', 'morning', 'evening', 'night', 'afternoon'
]);

/**
 * Extract meaningful keywords from text
 * @param {string} text - Text to extract keywords from
 * @returns {string[]} - Array of lowercase keywords
 */
function extractKeywords(text) {
  if (!text) return [];
  
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // Remove special characters
    .split(/\s+/)
    .filter(word => word.length > 2 && !STOP_WORDS.has(word))
    .slice(0, 20); // Limit to 20 keywords for performance
}

/**
 * Normalize location string for comparison
 * @param {string} location - Location string
 * @returns {string} - Normalized lowercase location
 */
function normalizeLocation(location) {
  if (!location) return '';
  return location.toLowerCase().trim();
}

/**
 * Calculate match score between two items
 * @param {Object} item1 - First item (typically the lost item)
 * @param {Object} item2 - Second item (typically the found item)
 * @returns {Object} - { score: number, matchDetails: Object }
 */
function calculateMatchScore(item1, item2) {
  let score = 0;
  const matchDetails = {
    category: false,
    location: false,
    keywordOverlap: 0,
    matchedKeywords: []
  };

  // 1. Category Match (exact match = full points)
  if (item1.category && item2.category && item1.category === item2.category) {
    score += WEIGHTS.category;
    matchDetails.category = true;
  }

  // 2. Location Match (fuzzy matching)
  const loc1 = item1.normalizedLocation || normalizeLocation(item1.location);
  const loc2 = item2.normalizedLocation || normalizeLocation(item2.location);
  
  if (loc1 && loc2) {
    if (loc1 === loc2) {
      // Exact match
      score += WEIGHTS.location;
      matchDetails.location = true;
    } else if (loc1.includes(loc2) || loc2.includes(loc1)) {
      // Partial match (one contains the other)
      score += WEIGHTS.location * 0.7;
      matchDetails.location = true;
    } else {
      // Check for common location words
      const words1 = loc1.split(/\s+/);
      const words2 = loc2.split(/\s+/);
      const commonWords = words1.filter(w => words2.includes(w) && w.length > 2);
      if (commonWords.length > 0) {
        score += WEIGHTS.location * 0.5;
        matchDetails.location = true;
      }
    }
  }

  // 3. Keyword Overlap (Jaccard-like scoring)
  const kw1 = new Set(item1.keywords || extractKeywords(`${item1.title} ${item1.description}`));
  const kw2 = new Set(item2.keywords || extractKeywords(`${item2.title} ${item2.description}`));
  
  const intersection = [...kw1].filter(k => kw2.has(k));
  const union = new Set([...kw1, ...kw2]);
  
  if (union.size > 0 && intersection.length > 0) {
    // Jaccard similarity coefficient
    const jaccardScore = intersection.length / union.size;
    // Also consider absolute overlap (more matches = better)
    const overlapBonus = Math.min(intersection.length / 5, 1) * 0.3;
    const keywordScore = (jaccardScore + overlapBonus) * WEIGHTS.keywords;
    score += keywordScore;
    matchDetails.keywordOverlap = intersection.length;
    matchDetails.matchedKeywords = intersection.slice(0, 5);
  }

  return { 
    score: Math.round(Math.min(score, 100)), // Cap at 100
    matchDetails 
  };
}

/**
 * Create a notification for the lost item owner
 * @param {Object} lostItem - The lost item document
 * @param {Object} foundItem - The found item document
 * @param {number} score - Match score
 * @param {Object} matchDetails - Details about what matched
 */
async function createNotification(lostItem, foundItem, score, matchDetails) {
  // Don't notify if same user posted both items
  if (lostItem.uid === foundItem.uid) {
    console.log('Same user posted both items, skipping notification');
    return null;
  }

  const notification = {
    userId: lostItem.uid,
    userEmail: lostItem.email,
    type: "match_found",
    title: "🎉 Potential Match Found!",
    message: `Your lost "${lostItem.title}" may match a found item "${foundItem.title}" near "${foundItem.location}".`,
    lostItemId: lostItem.id,
    foundItemId: foundItem.id,
    matchScore: score,
    matchDetails: matchDetails,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    emailSent: false
  };

  const notifRef = await db.collection("notifications").add(notification);
  console.log(`Created notification: ${notifRef.id}`);
  
  // Also save the match record for analytics/tracking
  await db.collection("matches").add({
    lostItemId: lostItem.id,
    foundItemId: foundItem.id,
    score: score,
    matchedOn: matchDetails,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    status: "pending"
  });

  return notification;
}

/**
 * Check for duplicate matches to avoid spam
 */
async function matchExists(lostItemId, foundItemId) {
  const existing = await db.collection("matches")
    .where("lostItemId", "==", lostItemId)
    .where("foundItemId", "==", foundItemId)
    .limit(1)
    .get();
  
  return !existing.empty;
}

// ==================== CLOUD FUNCTION TRIGGERS ====================

/**
 * Trigger when a new LOST item is posted
 * Searches existing FOUND items for matches
 */
exports.onLostItemCreated = functions.firestore
  .document("items/{itemId}")
  .onCreate(async (snap, context) => {
    const newItem = { id: context.params.itemId, ...snap.data() };
    
    // Only process LOST items
    if (newItem.type !== "lost") {
      console.log('Item is not a lost item, skipping');
      return null;
    }
    
    console.log(`Processing new LOST item: ${newItem.title} (${context.params.itemId})`);

    // Extract and save keywords for this item
    const keywords = extractKeywords(`${newItem.title} ${newItem.description}`);
    const normalizedLocation = normalizeLocation(newItem.location);
    
    await snap.ref.update({
      keywords,
      normalizedLocation,
      matchProcessed: true
    });

    // Find all FOUND items with status "open" (not expired)
    const now = Date.now();
    const foundItemsSnapshot = await db.collection("items")
      .where("type", "==", "found")
      .where("status", "==", "open")
      .get();

    const matches = [];
    
    for (const doc of foundItemsSnapshot.docs) {
      const foundItem = { id: doc.id, ...doc.data() };
      
      // Skip expired items
      if (foundItem.expiresAt && foundItem.expiresAt < now) {
        continue;
      }

      const { score, matchDetails } = calculateMatchScore(
        { ...newItem, keywords, normalizedLocation },
        foundItem
      );

      if (score >= MATCH_THRESHOLD) {
        matches.push({ foundItem, score, matchDetails });
      }
    }

    // Sort by score descending
    matches.sort((a, b) => b.score - a.score);

    // Create notifications for top 3 matches
    let notificationCount = 0;
    for (const match of matches.slice(0, 3)) {
      // Check if this match already exists
      const exists = await matchExists(newItem.id, match.foundItem.id);
      if (!exists) {
        await createNotification(newItem, match.foundItem, match.score, match.matchDetails);
        notificationCount++;
      }
    }

    console.log(`Created ${notificationCount} notifications for lost item: ${newItem.title}`);
    return null;
  });

/**
 * Trigger when a new FOUND item is posted
 * Searches existing LOST items for matches
 */
exports.onFoundItemCreated = functions.firestore
  .document("items/{itemId}")
  .onCreate(async (snap, context) => {
    const newItem = { id: context.params.itemId, ...snap.data() };
    
    // Only process FOUND items
    if (newItem.type !== "found") {
      console.log('Item is not a found item, skipping');
      return null;
    }
    
    console.log(`Processing new FOUND item: ${newItem.title} (${context.params.itemId})`);

    // Extract and save keywords for this item
    const keywords = extractKeywords(`${newItem.title} ${newItem.description}`);
    const normalizedLocation = normalizeLocation(newItem.location);
    
    await snap.ref.update({
      keywords,
      normalizedLocation,
      matchProcessed: true
    });

    // Find all LOST items with status "open" (not expired)
    const now = Date.now();
    const lostItemsSnapshot = await db.collection("items")
      .where("type", "==", "lost")
      .where("status", "==", "open")
      .get();

    const matches = [];
    
    for (const doc of lostItemsSnapshot.docs) {
      const lostItem = { id: doc.id, ...doc.data() };
      
      // Skip expired items
      if (lostItem.expiresAt && lostItem.expiresAt < now) {
        continue;
      }

      const { score, matchDetails } = calculateMatchScore(lostItem, { ...newItem, keywords, normalizedLocation });

      if (score >= MATCH_THRESHOLD) {
        matches.push({ lostItem, score, matchDetails });
      }
    }

    // Sort by score descending
    matches.sort((a, b) => b.score - a.score);

    // Create notifications for matching lost item owners
    let notificationCount = 0;
    for (const match of matches.slice(0, 3)) {
      // Check if this match already exists
      const exists = await matchExists(match.lostItem.id, newItem.id);
      if (!exists) {
        await createNotification(match.lostItem, newItem, match.score, match.matchDetails);
        notificationCount++;
      }
    }

    console.log(`Created ${notificationCount} notifications for found item: ${newItem.title}`);
    return null;
  });

// Export utility functions for testing
module.exports.extractKeywords = extractKeywords;
module.exports.normalizeLocation = normalizeLocation;
module.exports.calculateMatchScore = calculateMatchScore;
