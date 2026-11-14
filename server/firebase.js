/**
 * Firebase — ডিফল্ট স্থায়ী স্টোরেজ।
 *
 * Render-এর ফ্রি ইনস্ট্যান্সে ডিস্ক থাকে না, তাই SQLite ফাইলটা Firebase-এ রাখা হয়:
 *   takamatch_db/snapshot          → { parts, bytes, sha256, updated_at }
 *   takamatch_db/snapshot/parts/N  → base64 টুকরা (Firestore ডকুমেন্টে সর্বোচ্চ ১ MiB)
 *
 * বুটে স্ন্যাপশট নামিয়ে লোকাল ফাইলে লেখা হয়, আর প্রতিটি লেখার পরে (ডিবাউন্স)
 * আবার আপলোড হয় — ফলে সার্ভিস রিস্টার্ট/রিডিপ্লয়ে ডেটা থাকে।
 * Firebase Storage ব্যবহার করছি না, কারণ Storage আলাদা করে চালু করতে হয় ও ব্লেজ প্ল্যান লাগে;
 * Firestore ফ্রি (Spark) প্ল্যানেই চলে।
 */

import { initializeApp, getApps } from 'firebase/app';
import { getAnalytics, isSupported } from 'firebase/analytics';
import { getFirestore, doc, getDoc, setDoc, deleteDoc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID,
};

export function firebaseConfigured() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
}

let app = null;
let firestore = null;
let analytics = null;

export function getFirebaseApp() {
  if (!firebaseConfigured()) return null;
  if (!app) app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  return app;
}

export function getFirebaseFirestore() {
  const a = getFirebaseApp();
  if (!a) return null;
  if (!firestore) firestore = getFirestore(a);
  return firestore;
}

// অ্যানালিটিক্স ব্রাউজারে চলে, সার্ভারে চললে এরর এড়াতে চেক করে নেওয়া ভালো
if (firebaseConfigured()) {
  isSupported()
    .then((supported) => {
      if (supported) {
        try {
          analytics = getAnalytics(getFirebaseApp());
        } catch {
          /* সার্ভারে অসমর্থিত — চুপচাপ বাদ */
        }
      }
    })
    .catch(() => {});
}

export function getFirebaseAnalytics() {
  return analytics;
}

/* ─────────────────────────── স্ন্যাপশট (chunked) ─────────────────────────── */

const META_COLLECTION = 'takamatch_db';
const META_DOC = 'snapshot';
const PART_COLLECTION = 'parts';
// Firestore ডকুমেন্ট সীমা ১ MiB; base64 ~৩৩% বাড়ে, তাই ৪৮০ KB করে টুকরা
const CHUNK_CHARS = 480_000;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

const metaRef = () => doc(getFirebaseFirestore(), META_COLLECTION, META_DOC);
const partRef = (index) => doc(getFirebaseFirestore(), META_COLLECTION, META_DOC, PART_COLLECTION, `p${String(index).padStart(4, '0')}`);

/** Firestore থেকে স্ন্যাপশট নামায় — না থাকলে null */
export async function downloadDatabaseSnapshot() {
  if (!firebaseConfigured()) return null;

  let metaSnap;
  try {
    metaSnap = await getDoc(metaRef());
  } catch (err) {
    console.error('[firebase] স্ন্যাপশট মেটাডেটা পড়া যায়নি:', err?.code || err?.message || err);
    return null;
  }
  if (!metaSnap.exists()) return null;

  const meta = metaSnap.data() || {};
  const parts = Math.max(0, Number(meta.parts) || 0);
  if (!parts) return null;
  if (Number(meta.bytes) > MAX_TOTAL_BYTES) {
    console.error('[firebase] স্ন্যাপশট অনেক বড় — রিস্টোর বাদ দেওয়া হলো');
    return null;
  }

  const pieces = [];
  for (let i = 0; i < parts; i += 1) {
    const snap = await getDoc(partRef(i));
    if (!snap.exists()) {
      console.error(`[firebase] স্ন্যাপশটের ${i} নম্বর টুকরা নেই — রিস্টোর বাদ`);
      return null;
    }
    pieces.push(String(snap.data().data || ''));
  }

  return Buffer.from(pieces.join(''), 'base64');
}

/** স্ন্যাপশট আপলোড করে (পুরোনো বাড়তি টুকরা মুছে দেয়) */
export async function uploadDatabaseSnapshot(buffer) {
  if (!firebaseConfigured()) return false;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  if (buffer.length > MAX_TOTAL_BYTES) {
    console.error('[firebase] স্ন্যাপশট ২৪ MB ছাড়িয়ে গেছে — আপলোড বাদ');
    return false;
  }

  const base64 = buffer.toString('base64');
  const chunks = [];
  for (let i = 0; i < base64.length; i += CHUNK_CHARS) chunks.push(base64.slice(i, i + CHUNK_CHARS));

  const previous = await getDoc(metaRef()).then((s) => (s.exists() ? Number(s.data().parts) || 0 : 0)).catch(() => 0);

  for (let i = 0; i < chunks.length; i += 1) {
    await setDoc(partRef(i), { data: chunks[i], index: i });
  }
  await setDoc(metaRef(), {
    parts: chunks.length,
    bytes: buffer.length,
    updated_at: new Date().toISOString(),
    engine: 'sqlite',
  });

  // আগের সেভে বেশি টুকরা থাকলে মুছে দিই
  for (let i = chunks.length; i < previous; i += 1) {
    await deleteDoc(partRef(i)).catch(() => {});
  }
  return true;
}

export const firebaseStorageSnapshotPath = () => `firestore:${META_COLLECTION}/${META_DOC}`;
