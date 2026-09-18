import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import { pushConsoleLog } from "./live-console.js";
import {
  initAppwriteStorage,
  startAppwriteSync,
  scheduleSessionBackup,
  uploadTemporaryBuffer,
  isAppwriteEnabled,
  upsertUserFromMessage
} from "./appwrite-storage.js";

const SESSION_DIR = path.resolve(process.env.WA_SESSION_DIR || "/tmp/axynera-wa-session");
const PLUGIN_DIR = path.resolve(process.env.WA_PLUGIN_DIR || "/data/axynera-wa-plugins");
const MEDIA_DIR = path.resolve(process.env.WA_MEDIA_DIR || path.join(SESSION_DIR, "media"));
const PLUGIN_RELOAD_MS = Number(process.env.WA_PLUGIN_RELOAD_MS || 5000);
const AUTO_READ = String(process.env.WA_AUTO_READ || "true").toLowerCase() !== "false";
const AUTO_DOWNLOAD_IMAGES = String(process.env.WA_AUTO_DOWNLOAD_IMAGES || "true").toLowerCase() !== "false";
const AUTO_ONLINE = String(process.env.WA_AUTO_ONLINE || "true").toLowerCase() !== "false";
const PRESENCE_INTERVAL_MS = Math.max(30000, Number(process.env.WA_PRESENCE_INTERVAL_MS || 60000));
const ABOUT_UPDATE_MS = Math.max(60000, Number(process.env.WA_ABOUT_UPDATE_MS || 60000));
const ABOUT_FORCE_REFRESH_MS = Math.max(120000, Number(process.env.WA_ABOUT_FORCE_REFRESH_MS || 300000));
const ABOUT_PREFIX = String(process.env.WA_ABOUT_PREFIX || "🤖 Axynera Ai⌚ Aktif").trim();

// Baileys default query timeout terlalu ketat untuk hosting dengan latency tinggi ke server WA.
// Ini yang menyebabkan "unexpected error in 'init queries'" (fetchProps timeout) di awal koneksi.
const QUERY_TIMEOUT_MS = Math.max(30000, Number(process.env.WA_QUERY_TIMEOUT_MS || 60000));
const CONNECT_TIMEOUT_MS = Math.max(30000, Number(process.env.WA_CONNECT_TIMEOUT_MS || 60000));
const KEEPALIVE_MS = Math.max(10000, Number(process.env.WA_KEEPALIVE_MS || 20000));

// Reconnect backoff: mulai pendek, naik bertahap, dengan batas atas.
// Mencegah bot nge-spam reconnect saat WA sedang throttle/conflict berulang.
const RECONNECT_BASE_MS = Math.max(1000, Number(process.env.WA_RECONNECT_BASE_MS || 3000));
const RECONNECT_MAX_MS = Math.max(RECONNECT_BASE_MS, Number(process.env.WA_RECONNECT_MAX_MS || 60000));

const state = {
  status: "starting",
  qr: null,
  qrDataUrl: null,
  connectedAt: null,
  phone: null,
  pluginCount: 0,
  lastError: null,
  autoRead: AUTO_READ,
  autoDownloadImages: AUTO_DOWNLOAD_IMAGES,
  autoOnline: AUTO_ONLINE,
  about: null,
  aboutLastSuccessAt: null,
  updatedAt: Date.now()
};

let sock = null;
let pluginTimer = null;
let plugins = [];
let reconnectTimer = null;
let presenceTimer = null;
let aboutTimer = null;
let aboutKickTimers = [];
let activeSince = null;

// Guard krusial: mencegah dua connectWhatsApp() berjalan bersamaan.
// Tanpa ini, close-event yang beruntun (mis. karena conflict) bisa memicu
// beberapa makeWASocket() sekaligus memakai sesi yang sama -> saling bentrok -> conflict lagi.
let isConnecting = false;
let connectGeneration = 0;
let reconnectAttempts = 0;

function setState(patch = {}) {
  Object.assign(state, patch, { updatedAt: Date.now() });
}

function getText(message) {
  return message?.message?.conversation
    || message?.message?.extendedTextMessage?.text
    || message?.message?.imageMessage?.caption
    || message?.message?.videoMessage?.caption
    || message?.message?.documentMessage?.caption
    || "";
}

function jidLabel(jid = "") {
  return String(jid).replace(/@s\.whatsapp\.net$/i, "").replace(/@g\.us$/i, " [group]");
}

function safeName(value = "") {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

function imageExtension(message) {
  const mime = String(message?.message?.imageMessage?.mimetype || "image/jpeg").toLowerCase();
  if (mime.includes("png")) return ".png";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("gif")) return ".gif";
  return ".jpg";
}

function formatUptime(from = Date.now()) {
  const totalMinutes = Math.max(0, Math.floor((Date.now() - from) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days} Hari`);
  if (hours) parts.push(`${hours} Jam`);
  if (minutes || !parts.length) parts.push(`${minutes} Menit`);
  return parts.join(" ");
}

function stopLiveProfileTimers() {
  if (presenceTimer) clearInterval(presenceTimer);
  if (aboutTimer) clearInterval(aboutTimer);
  for (const timer of aboutKickTimers) clearTimeout(timer);
  aboutKickTimers = [];
  presenceTimer = null;
  aboutTimer = null;
}

async function updateOnlinePresence() {
  if (!sock || state.status !== "connected" || !AUTO_ONLINE) return;
  try {
    await sock.sendPresenceUpdate("available");
  } catch (error) {
    pushConsoleLog("presence_error", { error: error.message });
  }
}

async function updateDynamicAbout(force = false) {
  if (!sock || state.status !== "connected" || !state.connectedAt) return false;
  const about = `${ABOUT_PREFIX} ${formatUptime(activeSince || state.connectedAt)}`;
  const lastSuccess = Number(state.aboutLastSuccessAt || 0);
  const shouldForce = force || !lastSuccess || Date.now() - lastSuccess >= ABOUT_FORCE_REFRESH_MS;
  if (!shouldForce && about === state.about) return true;

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sock.updateProfileStatus(about);
      setState({ about, aboutLastSuccessAt: Date.now() });
      pushConsoleLog("about_update", { text: about, attempt, force: shouldForce });
      return true;
    } catch (error) {
      lastError = error;
      pushConsoleLog("about_retry", { attempt, error: error.message, text: about });
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
    }
  }

  pushConsoleLog("about_error", { error: lastError?.message || "unknown", text: about });
  return false;
}

function startLiveProfileTimers() {
  stopLiveProfileTimers();
  void updateOnlinePresence();
  void updateDynamicAbout(true);

  // WhatsApp kadang belum siap menerima profile-status tepat saat socket baru open.
  // Kick ulang setelah beberapa detik supaya About lebih konsisten muncul.
  for (const delay of [5000, 15000]) {
    const timer = setTimeout(() => void updateDynamicAbout(true), delay);
    timer.unref?.();
    aboutKickTimers.push(timer);
  }

  if (AUTO_ONLINE) {
    presenceTimer = setInterval(() => void updateOnlinePresence(), PRESENCE_INTERVAL_MS);
    presenceTimer.unref?.();
  }
  aboutTimer = setInterval(() => void updateDynamicAbout(false), ABOUT_UPDATE_MS);
  aboutTimer.unref?.();
}

async function downloadIncomingImage(message) {
  if (!AUTO_DOWNLOAD_IMAGES || message?.key?.fromMe || !message?.message?.imageMessage) return null;
  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const buffer = await downloadMediaMessage(message, "buffer", {});
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("buffer gambar kosong");
    const jid = safeName(message?.key?.remoteJid || "unknown");
    const id = safeName(message?.key?.id || Date.now());
    const filename = `${Date.now()}-${jid}-${id}${imageExtension(message)}`;
    const filePath = path.join(MEDIA_DIR, filename);
    fs.writeFileSync(filePath, buffer);
    const remote = isAppwriteEnabled()
      ? await uploadTemporaryBuffer(buffer, filename, Number(process.env.APPWRITE_TEMP_TTL_MS || 15 * 60 * 1000)).catch(() => null)
      : null;
    const media = {
      type: "image",
      path: filePath,
      filename,
      mimetype: message.message.imageMessage.mimetype || "image/jpeg",
      size: buffer.length,
      appwriteFileId: remote?.id || null,
      caption: message.message.imageMessage.caption || ""
    };
    pushConsoleLog("media_download", { jid: message?.key?.remoteJid || "", ...media });
    return media;
  } catch (error) {
    pushConsoleLog("media_download_error", { jid: message?.key?.remoteJid || "", error: error.message });
    return null;
  }
}

async function loadPlugins() {
  try {
    fs.mkdirSync(PLUGIN_DIR, { recursive: true });
    const files = fs.readdirSync(PLUGIN_DIR).filter((f) => f.endsWith(".js") || f.endsWith(".mjs")).sort((a, b) => {\n      if (a === "sticker.js") return -1;\n      if (b === "sticker.js") return 1;\n      return a.localeCompare(b);\n    });
    const loaded = [];
    for (const file of files) {
      try {
        const full = path.join(PLUGIN_DIR, file);
        const stat = fs.statSync(full);
        const mod = await import(`${pathToFileURL(full).href}?v=${stat.mtimeMs}`);
        const handler = mod.default || mod.handler || mod.onMessage;
        if (typeof handler === "function") {
          loaded.push({
            name: file,
            handler,
            onChatDelete: typeof mod.onChatDelete === "function" ? mod.onChatDelete : null,
            onMessagesDelete: typeof mod.onMessagesDelete === "function" ? mod.onMessagesDelete : null,
            onLidMapping: typeof mod.onLidMapping === "function" ? mod.onLidMapping : null
          });
        }
      } catch (error) {
        console.error(`[wa-plugin] gagal load ${file}:`, error.message);
        pushConsoleLog("plugin_error", { plugin: file, error: error.message });
      }
    }
    plugins = loaded;
    setState({ pluginCount: loaded.length });
  } catch (error) {
    console.error("[wa-plugin] loader error:", error.message);
    pushConsoleLog("plugin_loader_error", { error: error.message });
  }
}

async function dispatchPlugins(message, media = null) {
  if (!sock || !message?.message) return;
  for (const plugin of plugins) {
    try {
      const handled = await plugin.handler({
        sock,
        message,
        media,
        state: getWhatsAppState,
        log: (type, payload = {}) => pushConsoleLog(type, { plugin: plugin.name, ...payload })
      });
      // Plugin dapat mengklaim message agar plugin berikutnya tidak ikut memproses.
      // Ini mencegah command sticker/media bertabrakan dengan AI chat.
      if (handled === true) break;
    } catch (error) {
      console.error(`[wa-plugin] ${plugin.name} error:`, error.message);
      pushConsoleLog("plugin_error", { plugin: plugin.name, error: error.message });
    }
  }
}

async function dispatchPluginHook(hookName, payload = {}) {
  for (const plugin of plugins) {
    const hook = plugin?.[hookName];
    if (typeof hook !== "function") continue;
    try {
      await hook({
        sock,
        ...payload,
        state: getWhatsAppState,
        log: (type, data = {}) => pushConsoleLog(type, { plugin: plugin.name, ...data })
      });
    } catch (error) {
      console.error(`[wa-plugin] ${plugin.name} ${hookName} error:`, error.message);
      pushConsoleLog("plugin_hook_error", { plugin: plugin.name, hook: hookName, error: error.message });
    }
  }
}

// Backoff eksponensial dengan batas atas, plus sedikit jitter supaya tidak selalu presisi sama.
function nextReconnectDelay() {
  const exp = RECONNECT_BASE_MS * Math.pow(2, Math.min(reconnectAttempts, 6));
  const capped = Math.min(exp, RECONNECT_MAX_MS);
  const jitter = Math.floor(Math.random() * Math.min(1000, capped * 0.2));
  return capped + jitter;
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = nextReconnectDelay();
  reconnectAttempts += 1;
  pushConsoleLog("reconnect_scheduled", { delay, attempt: reconnectAttempts });
  reconnectTimer = setTimeout(() => void connectWhatsApp(), delay);
  reconnectTimer.unref?.();
}

// Menutup socket lama secara bersih sebelum membuat yang baru.
// Tanpa ini, socket lama tetap "hidup" secara logis di memori (event listener dsb)
// walau koneksinya sendiri sudah putus dari sisi server -> berkontribusi ke conflict berikutnya.
async function teardownSocket(reason = "teardown") {
  stopLiveProfileTimers();
  if (!sock) return;
  const old = sock;
  sock = null;
  try {
    old.ev.removeAllListeners();
  } catch {}
  try {
    old.end?.(new Error(reason));
  } catch {}
}

async function connectWhatsApp() {
  // Guard utama: kalau sudah ada proses connect yang berjalan, jangan mulai yang baru.
  if (isConnecting) {
    pushConsoleLog("connect_skipped", { reason: "already_connecting" });
    return;
  }
  isConnecting = true;
  clearTimeout(reconnectTimer);
  const myGeneration = ++connectGeneration;

  try {
    await teardownSocket("reconnect");
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    try {
      await initAppwriteStorage();
      await startAppwriteSync();
    } catch (error) {
      pushConsoleLog("appwrite_error", { error: error.message });
    }
    await loadPlugins();
    if (!pluginTimer) pluginTimer = setInterval(() => void loadPlugins(), PLUGIN_RELOAD_MS).unref();

    const { state: authState, saveCreds: persistCreds } = await useMultiFileAuthState(SESSION_DIR);
    const saveCreds = async () => {
      await persistCreds();
      scheduleSessionBackup();
    };
    const { version } = await fetchLatestBaileysVersion();

    // Kalau selama await di atas ada connect lain yang sudah start duluan (seharusnya tidak terjadi
    // karena isConnecting guard, tapi ini jaga-jaga terhadap race saat restartWhatsApp() manual dipanggil),
    // batalkan generasi ini supaya tidak bikin socket ganda.
    if (myGeneration !== connectGeneration) {
      pushConsoleLog("connect_aborted", { reason: "stale_generation" });
      return;
    }

    const newSock = makeWASocket({
      version,
      auth: authState,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: AUTO_ONLINE,
      browser: ["Axynera AI", "Chrome", "1.0.0"],
      defaultQueryTimeoutMs: QUERY_TIMEOUT_MS,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      keepAliveIntervalMs: KEEPALIVE_MS
    });
    sock = newSock;

    newSock.ev.on("creds.update", saveCreds);

    newSock.ev.on("messages.upsert", async ({ messages = [], type }) => {
      if (sock !== newSock) return; // socket ini sudah digantikan, abaikan event basi
      for (const message of messages) {
        if (!message?.message) continue;
        const jid = message?.key?.remoteJid || "";
        const text = String(getText(message)).trim();
        const fromMe = Boolean(message?.key?.fromMe);
        pushConsoleLog(fromMe ? "wa_out" : "wa_in", {
          jid,
          contact: jidLabel(jid),
          upsertType: type || null,
          text: text || `[${Object.keys(message.message || {})[0] || "message"}]`
        });

        if (type !== "notify") continue;

        if (AUTO_READ && !fromMe && message?.key) {
          await newSock.readMessages([message.key]).catch((error) => {
            pushConsoleLog("read_error", { jid, error: error.message });
          });
        }

        if (!fromMe) {\n          try { await upsertUserFromMessage(message); } catch (error) {\n            pushConsoleLog("user_db_error", { jid, error: error.message });\n          }\n        }\n\n        const media = await downloadIncomingImage(message);
        await dispatchPlugins(message, media);
      }
    });

    newSock.ev.on("chats.delete", async (jids = []) => {
      for (const jid of jids) {
        pushConsoleLog("chat_delete", { jid, contact: jidLabel(jid) });
        await dispatchPluginHook("onChatDelete", { jid });
      }
    });

    newSock.ev.on("messages.delete", async (event) => {
      await dispatchPluginHook("onMessagesDelete", { event });
    });

    newSock.ev.on("lid-mapping.update", async (mapping) => {
      pushConsoleLog("lid_mapping", { pn: mapping?.pn || null, lid: mapping?.lid || null });
      await dispatchPluginHook("onLidMapping", { mapping });
    });

    newSock.ev.on("messaging-history.set", async ({ lidPnMappings = [] }) => {
      for (const mapping of lidPnMappings || []) await dispatchPluginHook("onLidMapping", { mapping });
    });

    newSock.ev.on("connection.update", async (update) => {
      if (sock !== newSock) return; // event dari socket lama yang sudah digantikan
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        let qrDataUrl = null;
        try { qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 340 }); } catch {}
        setState({ status: "qr", qr, qrDataUrl, lastError: null });
        pushConsoleLog("connection", { status: "qr", text: "QR WhatsApp siap dipindai" });
      }
      if (connection === "open") {
        reconnectAttempts = 0; // reset backoff setelah berhasil connect
        const id = newSock?.user?.id || "";
        setState({
          status: "connected",
          qr: null,
          qrDataUrl: null,
          connectedAt: Date.now(),
          phone: id.split(":")[0] || null,
          lastError: null,
          about: null,
          aboutLastSuccessAt: null
        });
        if (!activeSince) activeSince = Date.now();
        startLiveProfileTimers();
        pushConsoleLog("connection", { status: "connected", text: "WhatsApp terhubung" });
      }
      if (connection === "close") {
        stopLiveProfileTimers();
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const isConflict = statusCode === DisconnectReason.connectionReplaced
          || String(lastDisconnect?.error?.message || "").toLowerCase().includes("conflict");
        setState({
          status: loggedOut ? "logged_out" : "disconnected",
          qr: null,
          qrDataUrl: null,
          lastError: lastDisconnect?.error?.message || null
        });
        pushConsoleLog("connection", {
          status: loggedOut ? "logged_out" : "disconnected",
          text: lastDisconnect?.error?.message || "Koneksi WhatsApp terputus",
          conflict: isConflict
        });
        if (sock === newSock) sock = null;
        if (!loggedOut) scheduleReconnect();
      }
    });
  } catch (error) {
    setState({ status: "error", lastError: error.message || String(error) });
    pushConsoleLog("connection_error", { error: error.message || String(error) });
    scheduleReconnect();
  } finally {
    isConnecting = false;
  }
}

export function getWhatsAppState() {
  return { ...state, pluginDir: PLUGIN_DIR, sessionDir: SESSION_DIR, mediaDir: MEDIA_DIR };
}

export async function restartWhatsApp() {
  clearTimeout(reconnectTimer);
  await teardownSocket("manual restart");
  setState({ status: "restarting", qr: null, qrDataUrl: null });
  pushConsoleLog("connection", { status: "restarting", text: "Restart koneksi manual" });
  reconnectAttempts = 0;
  await connectWhatsApp();
  return getWhatsAppState();
}

export async function logoutWhatsApp() {
  clearTimeout(reconnectTimer);
  try { await sock?.logout?.(); } catch {}
  await teardownSocket("logout");
  try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
  setState({ status: "logged_out", qr: null, qrDataUrl: null, phone: null, connectedAt: null, about: null, aboutLastSuccessAt: null });
  activeSince = null;
  pushConsoleLog("connection", { status: "logged_out", text: "Session WhatsApp dihapus" });
  reconnectAttempts = 0;
  scheduleReconnect();
  return getWhatsAppState();
}

void connectWhatsApp();
