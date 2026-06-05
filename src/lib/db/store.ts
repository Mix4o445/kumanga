import fs from "node:fs/promises";
import path from "node:path";
import admin from "firebase-admin";
import type { MangaStatus, ReviewStatus, StoredUser } from "@/types";

/**
 * Tiny database persistence layer.
 * Persists to Firebase Firestore when credentials are set in environment variables,
 * otherwise falls back to local `/data/*.json` files at the project root.
 *
 * Server-only: never import this from a Client Component.
 */

// --- Type Definitions (identical to original schema) ---

export interface StoredChapter {
  id: string;
  mangaId: string;
  number: number;
  title?: string;
  releasedAt: string;
  pages: string[];
  uploaderId: string;
  /** Admin review state. Absent = legacy/approved. */
  reviewStatus?: ReviewStatus;
}

export interface StoredManga {
  id: string;
  slug: string;
  title: string;
  authorName?: string;
  coverImage: string;
  bannerImage?: string;
  synopsis: string;
  genreSlugs: string[];
  status: MangaStatus;
  year?: number;
  views: number;
  uploaderId: string;
  createdAt: string;
  updatedAt: string;
  chapters: StoredChapter[];
  /** Admin review state. Absent = legacy/approved. */
  reviewStatus?: ReviewStatus;
}

export interface StoredReply {
  id: string;
  threadId: string;
  authorId: string;
  body: string;
  createdAt: string;
}

export interface StoredThread {
  id: string;
  /** Category slug (controlled vocabulary, see src/lib/forum.ts). */
  categoryId: string;
  authorId: string;
  title: string;
  body: string;
  createdAt: string;
  /** Bumped whenever a reply is added (drives "latest activity"). */
  updatedAt: string;
  replies: StoredReply[];
}

export interface StoredSupportMessage {
  id: string;
  senderId: string;
  /** True when sent by an admin (the support team). */
  fromAdmin: boolean;
  body: string;
  createdAt: string;
}

export interface StoredSupportConversation {
  /** Id of the (non-admin) user the conversation belongs to. */
  userId: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredSupportMessage[];
}

export interface StoredComment {
  id: string;
  /** "manga" or "chapter". */
  targetType: string;
  /** The manga id (for "manga") or chapter id (for "chapter"). */
  targetId: string;
  authorId: string;
  body: string;
  createdAt: string;
}

export interface StoredRating {
  mangaId: string;
  userId: string;
  value: number;
  updatedAt: string;
}

// --- Firebase Initialization with Fallback ---

let db: admin.firestore.Firestore | null = null;

const hasFirebaseConfig = 
  process.env.FIREBASE_PROJECT_ID && 
  process.env.FIREBASE_CLIENT_EMAIL && 
  process.env.FIREBASE_PRIVATE_KEY;

if (hasFirebaseConfig) {
  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
        }),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      });
    }
    db = admin.firestore();
  } catch (error) {
    console.error("Firebase admin initialization failed:", error);
  }
}

// --- File Storage Fallback Configuration ---

const DATA_DIR = path.join(process.cwd(), "data");
const MANGA_FILE = path.join(DATA_DIR, "manga.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const FORUM_FILE = path.join(DATA_DIR, "forum.json");
const SUPPORT_FILE = path.join(DATA_DIR, "support.json");
const COMMENTS_FILE = path.join(DATA_DIR, "comments.json");
const RATINGS_FILE = path.join(DATA_DIR, "ratings.json");

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJson<T>(file: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeJson<T>(file: string, data: T[]): Promise<void> {
  await ensureDir();
  const tmp = `${file}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

// --- Database Action Helpers ---

async function firebaseAll<T>(collectionName: string, jsonFile: string): Promise<T[]> {
  if (db) {
    try {
      const snapshot = await db.collection(collectionName).get();
      const items: T[] = [];
      snapshot.forEach((doc) => {
        items.push(doc.data() as T);
      });
      return items;
    } catch (e) {
      console.error(`Error reading collection ${collectionName} from Firestore, falling back:`, e);
    }
  }
  return readJson<T>(jsonFile);
}

async function firebaseSave<T>(
  collectionName: string,
  jsonFile: string,
  data: T[],
  idField: "id" | "composite_rating" | "composite_support"
): Promise<void> {
  if (db) {
    try {
      // Differential update to minimize Firestore writes
      const snapshot = await db.collection(collectionName).get();
      const currentMap = new Map<string, any>();
      snapshot.forEach((doc) => {
        currentMap.set(doc.id, doc.data());
      });

      const newKeys = new Set<string>();

      for (const item of data) {
        let key = "";
        if (idField === "id") {
          key = (item as any).id;
        } else if (idField === "composite_rating") {
          key = `${(item as any).userId}_${(item as any).mangaId}`;
        } else if (idField === "composite_support") {
          key = (item as any).userId;
        }
        if (!key) continue;
        newKeys.add(key);

        const existing = currentMap.get(key);
        if (!existing || JSON.stringify(existing) !== JSON.stringify(item)) {
          await db.collection(collectionName).doc(key).set(item as any);
        }
      }

      // Delete items no longer in source
      for (const key of currentMap.keys()) {
        if (!newKeys.has(key)) {
          await db.collection(collectionName).doc(key).delete();
        }
      }
      return;
    } catch (e) {
      console.error(`Error saving collection ${collectionName} to Firestore, falling back:`, e);
    }
  }
  await writeJson(jsonFile, data);
}

// --- Exported Stores ---

export const mangaStore = {
  all: () => firebaseAll<StoredManga>("manga", MANGA_FILE),
  save: (data: StoredManga[]) => firebaseSave("manga", MANGA_FILE, data, "id"),
};

export const userStore = {
  all: () => firebaseAll<StoredUser>("users", USERS_FILE),
  save: (data: StoredUser[]) => firebaseSave("users", USERS_FILE, data, "id"),
};

export const forumStore = {
  all: () => firebaseAll<StoredThread>("forum", FORUM_FILE),
  save: (data: StoredThread[]) => firebaseSave("forum", FORUM_FILE, data, "id"),
};

export const supportStore = {
  all: () => firebaseAll<StoredSupportConversation>("support", SUPPORT_FILE),
  save: (data: StoredSupportConversation[]) => firebaseSave("support", SUPPORT_FILE, data, "composite_support"),
};

export const commentsStore = {
  all: () => firebaseAll<StoredComment>("comments", COMMENTS_FILE),
  save: (data: StoredComment[]) => firebaseSave("comments", COMMENTS_FILE, data, "id"),
};

export const ratingsStore = {
  all: () => firebaseAll<StoredRating>("ratings", RATINGS_FILE),
  save: (data: StoredRating[]) => firebaseSave("ratings", RATINGS_FILE, data, "composite_rating"),
};
