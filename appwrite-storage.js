import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client, Storage, Databases, ID, InputFile, Query } from "node-appwrite";

const ENDPOINT = String(process.env.APPWRITE_ENDPOINT || "").trim().replace(/\/$/, "");
const PROJECT_ID = String(process.env.APPWRITE_PROJECT_ID || "").trim();
const API_KEY = String(process.env.APPWRITE_API_KEY || "").trim();
const BUCKET_ID = String(process.env.APPWRITE_BUCKET_ID || "botwa").trim();
const DATABASE_ID = String(process.env.APPWRITE_DATABASE_ID || "botwa").trim();
const USERS_COLLECTION_ID = String(process.env.APPWRITE_USERS_COLLECTION_ID || "users").trim();
const MEMORIES_COLLECTION_ID = String(process.env.APPWRITE_MEMORIES_COLLECTION_ID || "memories").trim();
const SESSIONS_COLLECTION_ID = String(process.env.APPWRITE_SESSIONS_COLLECTION_ID || "user_sessions").trim();
const PLUGIN_DIR = path.resolve(process.env.WA_PLUGIN_DIR || "/data/axynera-wa-plugins");
const SESSION_DIR = path.resolve(process.env.WA_SESSION_DIR || "/data/axynera-wa-session");

let storage = null;
let databases = null;
let ready = false;
let sessionSyncTimer = null;
let syncingSession = false;
let appwriteSyncStarted = false;

export function isAppwriteEnabled() {
  return Boolean(ENDPOINT && PROJECT_ID && API_KEY && BUCKET_ID);
}

function log(message, extra = {}) {
  console.log(`[appwrite] ${message}`, Object.keys(extra).length ? extra : "");
}

async function listFolder(folder) {
  const files = [];
  let offset = 0;
  while (true) {
    const result = await storage.listFiles({
      bucketId: BUCKET_ID,
      queries: [Query.equal("folder", [folder.endsWith("/") ? folder : folder + "/"]), Query.limit(100), Query.offset(offset)]
    });
    files.push(...(result.files || []));
    if (files.length >= Number(result.total || files.length) || !(result.files || []).length) break;
    offset += result.files.length;
  }
  return files;
}

async function findFile(folder, name) {
  const files = await listFolder(folder);
  return files.find((f) => f.name === name) || null;
}

async function removeFile(file) {
  if (!file?.$id) return;
  try { await storage.deleteFile({ bucketId: BUCKET_ID, fileId: file.$id }); } catch {}
}

async function uploadBuffer(buffer, name, folder) {
  const old = await findFile(folder, name);
  if (old) await removeFile(old);
  return storage.createFile({
    bucketId: BUCKET_ID,
    fileId: ID.unique(),
    file: InputFile.fromBuffer(buffer, name),
    folder
  });
}

async function downloadTo(file, destination) {
  const data = await storage.getFileDownload({ bucketId: BUCKET_ID, fileId: file.$id });
  const buffer = Buffer.from(data);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, buffer);
}

async function ensureDatabase() {
  try { await databases.get({ databaseId: DATABASE_ID }); } catch (error) {
    if (Number(error?.code || error?.response?.status || 0) !== 404) throw error;
    await databases.create({ databaseId: DATABASE_ID, name: "Axynera BotWA" });
    log("database_created", { databaseId: DATABASE_ID });
  }
}
async function ensureAttribute(collectionId, attr) {
  const collection = await databases.getCollection({ databaseId: DATABASE_ID, collectionId });
  if (collection.attributes?.some((a) => a.key === attr.key)) return;
  try {
    if (attr.type === "string") await databases.createStringAttribute({ databaseId: DATABASE_ID, collectionId, key: attr.key, size: attr.size || 255, required: Boolean(attr.required), default: attr.default ?? null });
    if (attr.type === "integer") await databases.createIntegerAttribute({ databaseId: DATABASE_ID, collectionId, key: attr.key, required: Boolean(attr.required), min: attr.min, max: attr.max, default: attr.default ?? null });
    if (attr.type === "datetime") await databases.createDatetimeAttribute({ databaseId: DATABASE_ID, collectionId, key: attr.key, required: Boolean(attr.required), default: attr.default ?? null });
  } catch (error) {
    if (Number(error?.code || 0) !== 409) throw error;
  }
}
async function ensureCollection(id, name, attributes = []) {
  try { await databases.getCollection({ databaseId: DATABASE_ID, collectionId: id }); } catch (error) {
    if (Number(error?.code || error?.response?.status || 0) !== 404) throw error;
    await databases.createCollection({ databaseId: DATABASE_ID, collectionId: id, name, permissions: [] });
    log("collection_created", { id, name });
  }
  for (const attr of attributes) await ensureAttribute(id, attr);
}
export async function ensureAppwriteDatabase() {
  if (!databases) return false;
  await ensureDatabase();
  await ensureCollection(USERS_COLLECTION_ID, "Users", [
    { key: "lid", type: "string", size: 128, required: true },
    { key: "username", type: "string", size: 255, required: false, default: "" },
    { key: "name", type: "string", size: 255, required: false, default: "" },
    { key: "role", type: "string", size: 20, required: true, default: "user" },
    { key: "status", type: "string", size: 20, required: true, default: "active" },
    { key: "message_count", type: "integer", required: true, default: 0, min: 0 },
    { key: "first_seen", type: "datetime", required: true },
    { key: "last_seen", type: "datetime", required: true },
    { key: "created_at", type: "datetime", required: true },
    { key: "updated_at", type: "datetime", required: true }
  ]);
  await ensureCollection(MEMORIES_COLLECTION_ID, "Memories", [
    { key: "user_id", type: "string", size: 128, required: true },
    { key: "memory", type: "string", size: 4000, required: true },
    { key: "type", type: "string", size: 64, required: false, default: "fact" },
    { key: "importance", type: "integer", required: false, default: 1, min: 1, max: 10 },
    { key: "created_at", type: "datetime", required: true },
    { key: "updated_at", type: "datetime", required: true }
  ]);
  await ensureCollection(SESSIONS_COLLECTION_ID, "User Sessions", [
    { key: "user_id", type: "string", size: 128, required: true },
    { key: "current_command", type: "string", size: 255, required: false, default: "" },
    { key: "pending_action", type: "string", size: 4000, required: false, default: "" },
    { key: "pending_media", type: "string", size: 4000, required: false, default: "" },
    { key: "expires_at", type: "datetime", required: false },
    { key: "updated_at", type: "datetime", required: true }
  ]);
  return true;
}

async function ensureBucket() {
  try {
    await storage.getBucket({ bucketId: BUCKET_ID });
  } catch (error) {
    const code = Number(error?.code || error?.response?.status || 0);
    if (code !== 404) throw error;
    await storage.createBucket({
      bucketId: BUCKET_ID,
      name: "Axynera BotWA",
      enabled: true,
      fileSecurity: false,
      encryption: true
    });
    log("bucket_created", { bucketId: BUCKET_ID });
  }
}

export async function initAppwriteStorage() {
  if (!isAppwriteEnabled()) return false;
  if (ready) return true;

  const client = new Client()
    .setEndpoint(ENDPOINT)
    .setProject(PROJECT_ID)
    .setKey(API_KEY);

  storage = new Storage(client);
  databases = new Databases(client);
  await ensureBucket();
  await ensureAppwriteDatabase();
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  await restoreSession();
  await syncPlugins();

  ready = true;
  log("ready", { bucketId: BUCKET_ID });
  return true;
}

export async function syncPlugins() {
  if (!storage) return false;
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  const remote = await listFolder("plugins");

  // First connection: seed the Appwrite plugin folder from the bundled plugins.
  // After that Appwrite becomes the source of truth; upload/delete plugins there.
  if (!remote.length) {
    const localFiles = fs.readdirSync(PLUGIN_DIR).filter((f) => /\.(js|mjs)$/.test(f));
    for (const name of localFiles) {
      const filePath = path.join(PLUGIN_DIR, name);
      await uploadBuffer(fs.readFileSync(filePath), name, "plugins");
    }
    log("plugins_seeded", { count: localFiles.length });
    return true;
  }

  const remoteNames = new Set();
  for (const file of remote) {
    if (!/\.(js|mjs)$/.test(file.name)) continue;
    remoteNames.add(file.name);
    await downloadTo(file, path.join(PLUGIN_DIR, file.name));
  }

  // Remove local plugin files that no longer exist remotely.
  for (const name of fs.readdirSync(PLUGIN_DIR)) {
    if (!/\.(js|mjs)$/.test(name)) continue;
    if (!remoteNames.has(name)) {
      try { fs.rmSync(path.join(PLUGIN_DIR, name), { force: true }); } catch {}
    }
  }
  log("plugins_synced", { count: remoteNames.size });
  return true;
}

function createSessionArchive() {
  const temp = path.join(os.tmpdir(), `axynera-session-${process.pid}-${Date.now()}.tar.gz`);
  const result = spawnSync("tar", ["-czf", temp, "--exclude=./sticker-pending", "-C", SESSION_DIR, "."], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "gagal membuat arsip session");
  return temp;
}

async function backupSessionNow() {
  if (!storage || syncingSession || !fs.existsSync(SESSION_DIR)) return;
  syncingSession = true;
  let archive = null;
  try {
    archive = createSessionArchive();
    const buffer = fs.readFileSync(archive);
    await uploadBuffer(buffer, "session.tar.gz", "session");
    log("session_synced", { bytes: buffer.length });
  } catch (error) {
    log("session_sync_error", { error: error.message });
  } finally {
    if (archive) try { fs.rmSync(archive, { force: true }); } catch {}
    syncingSession = false;
  }
}

export function scheduleSessionBackup() {
  if (!storage) return;
  clearTimeout(sessionSyncTimer);
  sessionSyncTimer = setTimeout(() => void backupSessionNow(), 8000);
  sessionSyncTimer.unref?.();
}

export async function restoreSession() {
  if (!storage) return false;
  const remote = await findFile("session", "session.tar.gz");
  if (!remote) return false;

  const temp = path.join(os.tmpdir(), `axynera-restore-${process.pid}.tar.gz`);
  try {
    const data = await storage.getFileDownload({ bucketId: BUCKET_ID, fileId: remote.$id });
    fs.writeFileSync(temp, Buffer.from(data));
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    const result = spawnSync("tar", ["-xzf", temp, "-C", SESSION_DIR], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || "gagal restore session");
    log("session_restored");
    return true;
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch {}
  }
}

export async function uploadTemporaryBuffer(buffer, name, ttlMs = 15 * 60 * 1000) {
  if (!storage || !Buffer.isBuffer(buffer) || !buffer.length) return null;
  const safe = String(name || "upload.bin").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
  const file = await storage.createFile({
    bucketId: BUCKET_ID,
    fileId: ID.unique(),
    file: InputFile.fromBuffer(buffer, safe),
    folder: "temp"
  });

  const timer = setTimeout(async () => {
    try { await storage.deleteFile({ bucketId: BUCKET_ID, fileId: file.$id }); } catch {}
  }, Math.max(1000, ttlMs));
  timer.unref?.();

  return { id: file.$id, name: file.name };
}

export async function deleteTemporaryFile(id) {
  if (!storage || !id) return;
  try { await storage.deleteFile({ bucketId: BUCKET_ID, fileId: id }); } catch {}
}

export async function startAppwriteSync() {
  if (!storage || appwriteSyncStarted) return;
  appwriteSyncStarted = true;
  const interval = Math.max(15000, Number(process.env.APPWRITE_PLUGIN_SYNC_MS || 30000));
  setInterval(() => void syncPlugins().catch((e) => log("plugin_sync_error", { error: e.message })), interval).unref?.();
}


function getMessageUser(message) {
  const raw = message?.key?.participant || message?.key?.remoteJid || "";
  if (!/@lid$/i.test(String(raw))) return null;
  return { lid: String(raw).replace(/@lid$/i, "").trim(), username: String(message?.pushName || "").trim() };
}
async function findUserByLid(lid) {
  const result = await databases.listDocuments({ databaseId: DATABASE_ID, collectionId: USERS_COLLECTION_ID, queries: [Query.equal("lid", [String(lid)]), Query.limit(1)] });
  return result.documents?.[0] || null;
}
export async function upsertUserFromMessage(message) {
  if (!databases || !ready) return null;
  const identity = getMessageUser(message);
  if (!identity?.lid) return null;
  const now = new Date().toISOString();
  const user = await findUserByLid(identity.lid);
  if (!user) return databases.createDocument({ databaseId: DATABASE_ID, collectionId: USERS_COLLECTION_ID, documentId: ID.unique(), data: { lid: identity.lid, username: identity.username || "", name: "", role: "user", status: "active", message_count: 1, first_seen: now, last_seen: now, created_at: now, updated_at: now } });
  const patch = { last_seen: now, updated_at: now, message_count: Number(user.message_count || 0) + 1 };
  if (identity.username && !user.username) patch.username = identity.username;
  return databases.updateDocument({ databaseId: DATABASE_ID, collectionId: USERS_COLLECTION_ID, documentId: user.$id, data: patch });
}
export async function listUsers({ limit = 100, offset = 0 } = {}) {
  if (!databases || !ready) return { documents: [], total: 0 };
  return databases.listDocuments({ databaseId: DATABASE_ID, collectionId: USERS_COLLECTION_ID, queries: [Query.orderDesc("last_seen"), Query.limit(Math.min(100, Math.max(1, Number(limit)))), Query.offset(Math.max(0, Number(offset)))] });
}
export async function updateUser(id, data) {
  if (!databases || !ready) throw new Error("Appwrite database belum siap.");
  const allowed = {};
  for (const key of ["username", "name", "role", "status"]) if (data?.[key] !== undefined) allowed[key] = String(data[key]);
  allowed.updated_at = new Date().toISOString();
  if (allowed.role && !["owner", "user"].includes(allowed.role)) throw new Error("Role harus owner atau user.");
  if (allowed.status && !["active", "blocked"].includes(allowed.status)) throw new Error("Status tidak valid.");
  return databases.updateDocument({ databaseId: DATABASE_ID, collectionId: USERS_COLLECTION_ID, documentId: id, data: allowed });
}
export async function deleteUser(id) {
  if (!databases || !ready) throw new Error("Appwrite database belum siap.");
  return databases.deleteDocument({ databaseId: DATABASE_ID, collectionId: USERS_COLLECTION_ID, documentId: id });
}
