import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client, Storage, ID, InputFile, Query } from "node-appwrite";

const ENDPOINT = String(process.env.APPWRITE_ENDPOINT || "").trim().replace(/\/$/, "");
const PROJECT_ID = String(process.env.APPWRITE_PROJECT_ID || "").trim();
const API_KEY = String(process.env.APPWRITE_API_KEY || "").trim();
const BUCKET_ID = String(process.env.APPWRITE_BUCKET_ID || "botwa").trim();
const PLUGIN_DIR = path.resolve(process.env.WA_PLUGIN_DIR || "/data/axynera-wa-plugins");
const SESSION_DIR = path.resolve(process.env.WA_SESSION_DIR || "/data/axynera-wa-session");

let storage = null;
let ready = false;
let sessionSyncTimer = null;
let syncingSession = false;

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
  await ensureBucket();
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
  if (!storage) return;
  const interval = Math.max(15000, Number(process.env.APPWRITE_PLUGIN_SYNC_MS || 30000));
  setInterval(() => void syncPlugins().catch((e) => log("plugin_sync_error", { error: e.message })), interval).unref?.();
}
