import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { File } from "node:buffer";
import { spawnSync } from "node:child_process";
import { Client, Storage, Databases, ID, Query } from "node-appwrite";

const ENDPOINT = String(process.env.APPWRITE_ENDPOINT || "").trim().replace(/\/$/, "");
const PROJECT_ID = String(process.env.APPWRITE_PROJECT_ID || "").trim();
const API_KEY = String(process.env.APPWRITE_API_KEY || "").trim();
let BUCKET_ID = String(process.env.APPWRITE_BUCKET_ID || "botwa").trim();
const DATABASE_ID = String(process.env.APPWRITE_DATABASE_ID || "botwa").trim();
const USERS_COLLECTION_ID = String(process.env.APPWRITE_USERS_COLLECTION_ID || "users").trim();
const MEMORIES_COLLECTION_ID = String(process.env.APPWRITE_MEMORIES_COLLECTION_ID || "memories").trim();
const SESSIONS_COLLECTION_ID = String(process.env.APPWRITE_SESSIONS_COLLECTION_ID || "user_sessions").trim();
const PLUGIN_DIR = path.resolve(process.env.WA_PLUGIN_DIR || "./plugins");
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
  // Folder listing can be inconsistent across Appwrite versions. For named
  // persistent files (especially the WhatsApp session), search by filename
  // directly and use the folder only as a secondary filter.
  const result = await storage.listFiles({
    bucketId: BUCKET_ID,
    queries: [Query.equal("name", [name]), Query.limit(100)]
  });
  const files = result.files || [];
  return files.find((file) => {
    const fileFolder = String(file?.folder || "").replace(/^\/+|\/+$/g, "");
    const wantedFolder = String(folder || "").replace(/^\/+|\/+$/g, "");
    return file.name === name && (!fileFolder || fileFolder === wantedFolder);
  }) || files.find((file) => file.name === name) || null;
}

async function removeFile(file) {
  if (!file?.$id) return;
  try { await storage.deleteFile({ bucketId: BUCKET_ID, fileId: file.$id }); } catch {}
}

async function uploadBuffer(buffer, name, folder) {
  if (!storage) throw new Error("Appwrite Storage belum siap.");
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  const old = await findFile(folder, name);
  try {
    // Upload first, delete the previous copy only after the new upload succeeds.
    // This prevents a transient Appwrite error from destroying the last backup.
    const created = await storage.createFile({
      bucketId: BUCKET_ID,
      fileId: ID.unique(),
      file: new File([buffer], name, { type: "application/octet-stream" }),
      folder
    });
    if (old && old.$id !== created.$id) await removeFile(old);
    return created;
  } catch (error) {
    log("file_upload_error", {
      name,
      folder,
      bytes: buffer.length,
      message: error?.message || String(error),
      code: error?.code ?? error?.response?.status ?? null,
      type: error?.type ?? null
    });
    throw error;
  }
}

async function selfTestStorage() {
  if (!storage) return false;
  const name = "__axynera_storage_test_" + process.pid + "_" + Date.now() + ".txt";
  const payload = Buffer.from("Axynera Appwrite Storage OK " + new Date().toISOString() + "\n", "utf8");
  try {
    log("storage_self_test_start", { bucketId: BUCKET_ID });
    const file = await storage.createFile({
      bucketId: BUCKET_ID,
      fileId: ID.unique(),
      file: new File([payload], name, { type: "text/plain" })
    });
    log("storage_self_test_ok", { fileId: file.$id, name: file.name, bytes: payload.length });
    try {
      await storage.deleteFile({ bucketId: BUCKET_ID, fileId: file.$id });
      log("storage_self_test_cleanup_ok", { fileId: file.$id });
    } catch (cleanupError) {
      log("storage_self_test_cleanup_error", {
        message: cleanupError?.message || String(cleanupError),
        code: cleanupError?.code ?? cleanupError?.response?.status ?? null,
        type: cleanupError?.type ?? null
      });
    }
    return true;
  } catch (error) {
    log("storage_self_test_failed", {
      message: error?.message || String(error),
      code: error?.code ?? error?.response?.status ?? null,
      type: error?.type ?? null
    });
    return false;
  }
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
    const base = { databaseId: DATABASE_ID, collectionId, key: attr.key, required: Boolean(attr.required) };
    if (attr.default !== undefined) base.default = attr.default;
    if (attr.type === "string") await databases.createStringAttribute({ ...base, size: attr.size || 255 });
    if (attr.type === "integer") {
      if (attr.min !== undefined) base.min = attr.min;
      if (attr.max !== undefined) base.max = attr.max;
      await databases.createIntegerAttribute(base);
    }
    if (attr.type === "datetime") await databases.createDatetimeAttribute(base);
    await new Promise((resolve) => setTimeout(resolve, 250));
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
    log("bucket_found", { bucketId: BUCKET_ID });
    return;
  } catch (error) {
    const code = Number(error?.code || error?.response?.status || 0);
    if (code !== 404) throw error;
  }

  // Appwrite's console may create a bucket with a generated ID while the
  // human-readable name is "botwa". If APPWRITE_BUCKET_ID points to that
  // name/old ID, resolve the real bucket ID before creating anything.
  try {
    const result = await storage.listBuckets({
      queries: [Query.equal("name", ["botwa"]), Query.limit(10)]
    });
    const existing = result.buckets?.[0];
    if (existing?.$id) {
      BUCKET_ID = existing.$id;
      log("bucket_resolved_by_name", { name: existing.name, bucketId: BUCKET_ID });
      return;
    }
  } catch (error) {
    log("bucket_lookup_error", {
      requestedBucketId: BUCKET_ID,
      message: error?.message || String(error),
      code: error?.code ?? error?.response?.status ?? null,
      type: error?.type ?? null
    });
  }

  try {
    await storage.createBucket({
      bucketId: BUCKET_ID,
      name: "botwa",
      enabled: true,
      fileSecurity: false,
      encryption: true
    });
    log("bucket_created", { bucketId: BUCKET_ID });
  } catch (error) {
    log("bucket_init_error", {
      requestedBucketId: BUCKET_ID,
      message: error?.message || String(error),
      code: error?.code ?? error?.response?.status ?? null,
      type: error?.type ?? null
    });
    throw error;
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
  await selfTestStorage();

  // Restore the WhatsApp auth archive before Baileys creates/reads auth state.
  // Database setup must not block session restoration on ephemeral hosts.
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  log("session_restore_prepare", { sessionDir: SESSION_DIR });
  const restored = await restoreSession();
  log("session_restore_result", { restored });

  try {
    await ensureAppwriteDatabase();
  } catch (error) {
    log("database_init_error", { error: error?.message || String(error), code: error?.code ?? error?.response?.status ?? null });
  }

  await syncPlugins();
  await cleanupExpiredTemporaryFiles();

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
    log("session_sync_error", { error: error?.message || String(error), code: error?.code || null, type: error?.type || null });
  } finally {
    if (archive) try { fs.rmSync(archive, { force: true }); } catch {}
    syncingSession = false;
  }
}

export async function backupSessionNowPublic() { await backupSessionNow(); }

export function scheduleSessionBackup() {
  if (!storage) return;
  clearTimeout(sessionSyncTimer);
  sessionSyncTimer = setTimeout(() => void backupSessionNow(), 8000);
  sessionSyncTimer.unref?.();
}

export async function restoreSession() {
  if (!storage) return false;
  try {
    log("session_restore_start", { bucketId: BUCKET_ID });
    const remote = await findFile("session", "session.tar.gz");
    if (!remote) {
      log("session_restore_missing", { name: "session.tar.gz" });
      return false;
    }

    const temp = path.join(os.tmpdir(), `axynera-restore-${process.pid}.tar.gz`);
    try {
      const data = await storage.getFileDownload({ bucketId: BUCKET_ID, fileId: remote.$id });
      fs.writeFileSync(temp, Buffer.from(data));
      fs.mkdirSync(SESSION_DIR, { recursive: true });
      const result = spawnSync("tar", ["-xzf", temp, "-C", SESSION_DIR], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr || "gagal restore session");
      log("session_restored", { fileId: remote.$id, bytes: fs.statSync(temp).size });
      return true;
    } finally {
      try { fs.rmSync(temp, { force: true }); } catch {}
    }
  } catch (error) {
    log("session_restore_error", {
      message: error?.message || String(error),
      code: error?.code ?? error?.response?.status ?? null,
      type: error?.type ?? null
    });
    return false;
  }
}

export async function uploadPluginFile(content, name) {
  if (!storage) throw new Error("Appwrite storage belum siap.");
  const safe = String(name || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  if (!/^[a-zA-Z0-9._-]+\.(?:js|mjs)$/.test(safe)) throw new Error("Nama plugin tidak valid.");
  return uploadBuffer(Buffer.from(String(content || ""), "utf8"), safe, "plugins");
}

export async function deletePluginFile(name) {
  if (!storage) return;
  const safe = String(name || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  const file = await findFile("plugins", safe);
  if (file) await removeFile(file);
}

async function cleanupExpiredTemporaryFiles() {
  if (!storage) return;
  const ttl = Math.max(60000, Number(process.env.WA_MEDIA_TTL_MS || process.env.APPWRITE_TEMP_TTL_MS || 15 * 60 * 1000));
  const cutoff = Date.now() - ttl;
  try {
    const files = await listFolder("temp");
    for (const file of files) {
      const created = Date.parse(file.$createdAt || file.$updatedAt || "");
      if (Number.isFinite(created) && created < cutoff) await removeFile(file);
    }
    log("temp_cleanup", { ttlMs: ttl });
  } catch (error) {
    log("temp_cleanup_error", { error: error.message });
  }
}

export async function uploadTemporaryBuffer(buffer, name, ttlMs = 15 * 60 * 1000) {
  if (!storage || !Buffer.isBuffer(buffer) || !buffer.length) return null;
  const safe = String(name || "upload.bin").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
  const file = await uploadBuffer(buffer, safe, "temp");

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
