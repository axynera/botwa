import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

function getText(m) {
  return (
    m?.message?.conversation ||
    m?.message?.extendedTextMessage?.text ||
    m?.message?.imageMessage?.caption ||
    m?.message?.videoMessage?.caption ||
    ""
  );
}

function getContextInfo(m) {
  const msg = m?.message;
  if (!msg) return null;
  return (
    msg.extendedTextMessage?.contextInfo ||
    msg.imageMessage?.contextInfo ||
    msg.stickerMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.documentMessage?.contextInfo ||
    msg.viewOnceMessage?.message?.imageMessage?.contextInfo ||
    msg.viewOnceMessageV2?.message?.imageMessage?.contextInfo ||
    null
  );
}

const MAX_TURNS = Math.max(2, Number(process.env.AXYNITY_MEMORY_TURNS || 20));
const STREAM_EDIT_MS = Math.max(700, Number(process.env.AXYNITY_STREAM_EDIT_MS || 1200));
const THINK_ANIMATION_MS = Math.max(700, Number(process.env.AXYNITY_THINK_ANIMATION_MS || 900));
const MAX_IMAGE_BYTES = Math.max(256000, Number(process.env.AXYNITY_MAX_IMAGE_BYTES || process.env.NERA_AI_MAX_IMAGE_BYTES || 8 * 1024 * 1024));
const SESSION_DIR = path.resolve(process.env.WA_SESSION_DIR || "/tmp/axynera-wa-session");
const MEMORY_FILE = path.resolve(process.env.AXYNITY_MEMORY_FILE || path.join(SESSION_DIR, "axynity-memory.json"));

const TEXT_TIMEOUT_MS = Number(process.env.AXYNITY_TIMEOUT_MS || 120000);
const IMAGE_TIMEOUT_MS = Number(process.env.AXYNITY_IMAGE_TIMEOUT_MS || 180000);

const AXYNITY_API_KEY = String(process.env.AXYNITY_API_KEY || process.env.NERA_AI_API_KEY || "").trim();
const OWNER_JID = String(process.env.OWNER_JID || "").trim();

if (!AXYNITY_API_KEY) {
  console.error("[axynity-plugin] FATAL: AXYNITY_API_KEY belum di-set di environment.");
}

const SYSTEM_PROMPT = {
  role: "system",
  content: "Kamu adalah Axynity, AI WhatsApp yang asyik, santai, dan friendly! Berikan jawaban yang jelas, informatif, dengan panjang yang sedang (pas, tidak terlalu panjang bertele-tele dan tidak terlalu singkat). Gunakan bahasa santai sehari-hari seperti teman ngobrol di WhatsApp. Gunakan emoji yang pas dan santai (seperti 👍, 🔥, 😂, ✨, 😎, 🗿, 😢, 😡, 😲), hindari emoji romantis atau berlebihan (seperti 💖, 😘, ❤️, 🥺). Tetap responsif, asyik, dan seru!"
};

function emptyStore() { return { version: 1, aliases: {}, sessions: {}, registeredLids: [] }; }
function loadStore() {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    if (!fs.existsSync(MEMORY_FILE)) return emptyStore();
    const x = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    return {
      version: 1,
      aliases: x?.aliases || {},
      sessions: x?.sessions || {},
      registeredLids: Array.isArray(x?.registeredLids) ? x.registeredLids : []
    };
  } catch (e) {
    console.error("[axynity-memory] gagal membaca:", e.message);
    return emptyStore();
  }
}
const store = loadStore();
function saveStore() {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    const tmp = `${MEMORY_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
    fs.renameSync(tmp, MEMORY_FILE);
  } catch (e) { console.error("[axynity-memory] gagal menyimpan:", e.message); }
}

const norm = (v = "") => String(v || "").trim().toLowerCase();
const isLid = (v = "") => norm(v).endsWith("@lid");
const canonical = (v = "") => norm(store.aliases[norm(v)] || norm(v));
const firstLid = (arr = []) => arr.map(norm).find(isLid) || "";
const firstJid = (arr = []) => arr.map(norm).find(Boolean) || "";

function getIdentity(message) {
  const k = message?.key || {};
  const remote = norm(k.remoteJid);
  if (remote.endsWith("@g.us")) {
    const candidates = [k.participant, k.participantAlt, k.senderLid, k.senderPn, k.participantPn];
    const p = canonical(firstLid(candidates) || firstJid(candidates) || "unknown");
    return { key: `group:${remote}|user:${p}`, identity: p, chatJid: remote, groupJid: remote };
  }
  const candidates = [k.remoteJid, k.remoteJidAlt, k.senderLid, k.senderPn, k.participant, k.participantAlt];
  const id = canonical(firstLid(candidates) || firstJid(candidates) || remote);
  return { key: `dm:${id}`, identity: id, chatJid: remote || id, groupJid: null };
}

function newSession(info) {
  const now = Date.now();
  return { id: randomUUID(), identity: info.identity, chatJids: [...new Set([info.chatJid, info.identity].filter(Boolean))], groupJid: info.groupJid, messages: [], createdAt: now, updatedAt: now };
}
function getSession(info) {
  if (!store.sessions[info.key]) { store.sessions[info.key] = newSession(info); saveStore(); }
  return store.sessions[info.key];
}
const trimMessages = (m = []) => m.slice(-(MAX_TURNS * 2));
function migrateAlias(pn, lid, log) {
  const a = norm(pn), b = norm(lid); if (!a || !b || !isLid(b)) return;
  store.aliases[a] = b; store.aliases[b] = b;
  const oldKey = `dm:${a}`, newKey = `dm:${b}`;
  if (store.sessions[oldKey]) {
    if (!store.sessions[newKey]) store.sessions[newKey] = store.sessions[oldKey];
    else store.sessions[newKey].messages = trimMessages([...(store.sessions[oldKey].messages || []), ...(store.sessions[newKey].messages || [])]);
    store.sessions[newKey].identity = b; delete store.sessions[oldKey];
  }
  for (const [k, s] of Object.entries(store.sessions)) {
    if (!k.includes(`|user:${a}`)) continue;
    const nk = k.replace(`|user:${a}`, `|user:${b}`);
    if (!store.sessions[nk]) { s.identity = b; store.sessions[nk] = s; }
    delete store.sessions[k];
  }
  saveStore(); log?.("ai_lid_mapping", { pn: a, lid: b });
}
function resetSessionsForChat(jid, log) {
  const a = norm(jid), b = canonical(a); let removed = 0;
  for (const [k, s] of Object.entries(store.sessions)) {
    const chats = (s.chatJids || []).map(norm);
    if (k === `dm:${a}` || k === `dm:${b}` || s.groupJid === a || chats.includes(a) || chats.includes(b)) { delete store.sessions[k]; removed++; }
  }
  if (removed) saveStore(); log?.("ai_memory_reset", { jid: a, removed, reason: "chat_deleted" });
}

function parseSseBlock(block) {
  let event = "message"; const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join("\n") };
}
function extractSseText(payload) {
  if (!payload || payload === "[DONE]") return { type: "none", text: "" };
  try {
    const d = JSON.parse(payload);
    const delta = d?.choices?.[0]?.delta?.content ?? d?.delta ?? d?.content?.delta;
    if (delta != null) return { type: "delta", text: String(delta) };
    const full = d?.choices?.[0]?.message?.content ?? d?.message?.content;
    if (full != null) return { type: "full", text: String(full) };
    if (typeof d?.text === "string") return { type: "delta", text: d.text };
    if (typeof d?.content === "string") return { type: "delta", text: d.content };
  } catch {}
  return { type: "none", text: "" };
}

function stripHiddenReasoning(v = "") {
  let t = String(v || "");
  t = t.replace(/<(?:minimax:)?(?:think|reasoning|analysis)\b[^>]*>[\s\S]*?(?:<\/(?:minimax:)?(?:think|reasoning|analysis)>|$)/gi, "");
  t = t.replace(/<\/?(?:minimax:)?(?:think|reasoning|analysis)\b[^>]*>/gi, "");
  return t.trim();
}

// Konversi Gambar/GIF/Video ke WebP Sticker (Mendukung Stiker Gerak/Animated)
async function convertMediaToWebp(buffer, isAnimated = false) {
  if (isAnimated) {
    try {
      return await new Promise((resolve, reject) => {
        const ff = spawn("ffmpeg", [
          "-i", "pipe:0",
          "-vf", "scale=512:512:force_original_aspect_ratio=decrease,fps=12,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
          "-loop", "0",
          "-preset", "default",
          "-an",
          "-vsync", "0",
          "-fs", "900000",
          "-f", "webp",
          "pipe:1"
        ]);
        const chunks = [];
        ff.stdout.on("data", (chunk) => chunks.push(chunk));
        ff.on("close", (code) => {
          if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
          else reject(new Error("FFmpeg animated sticker conversion failed"));
        });
        ff.on("error", reject);
        ff.stdin.write(buffer);
        ff.stdin.end();
      });
    } catch {
      // Fallback jika animasi gagal
    }
  }

  try {
    const sharp = (await import("sharp")).default;
    return await sharp(buffer)
      .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    return new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-i", "pipe:0",
        "-vf", "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
        "-f", "webp",
        "pipe:1"
      ]);
      const chunks = [];
      ff.stdout.on("data", (chunk) => chunks.push(chunk));
      ff.on("close", (code) => {
        if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
        else reject(new Error("FFmpeg error"));
      });
      ff.on("error", reject);
      ff.stdin.write(buffer);
      ff.stdin.end();
    });
  }
}

// EKSTRAKSI BEBERAPA FRAME (MULTI-FRAME) AGAR AI BISA DETEKSI GERAKAN
async function extractMultiFramesForAi(buffer, count = 3) {
  try {
    return await new Promise((resolve) => {
      const ff = spawn("ffmpeg", [
        "-i", "pipe:0",
        "-vf", `fps=2,scale=320:320:force_original_aspect_ratio=decrease`,
        "-vframes", String(count),
        "-f", "image2pipe",
        "-c:v", "mjpeg",
        "pipe:1"
      ]);
      const chunks = [];
      ff.stdout.on("data", (chunk) => chunks.push(chunk));
      ff.on("close", (code) => {
        if (code === 0 && chunks.length) {
          const fullBuf = Buffer.concat(chunks);
          const frames = [];
          let start = 0;
          while (start < fullBuf.length) {
            const soi = fullBuf.indexOf(Buffer.from([0xff, 0xd8]), start);
            if (soi === -1) break;
            const eoi = fullBuf.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
            if (eoi === -1) break;
            frames.push(fullBuf.subarray(soi, eoi + 2));
            start = eoi + 2;
          }
          resolve(frames.length > 0 ? frames.slice(0, count) : [buffer]);
        } else {
          resolve([buffer]);
        }
      });
      ff.on("error", () => resolve([buffer]));
      ff.stdin.write(buffer);
      ff.stdin.end();
    });
  } catch {
    return [buffer];
  }
}

async function downloadWhatsAppMedia(targetMsg, mediaType = "buffer") {
  try {
    let downloadMediaMessage;
    try {
      const baileys = await import("@whiskeysockets/baileys");
      downloadMediaMessage = baileys.downloadMediaMessage;
    } catch {
      const baileys = await import("@adiwajshing/baileys");
      downloadMediaMessage = baileys.downloadMediaMessage;
    }
    return await downloadMediaMessage(targetMsg, mediaType, {});
  } catch (err) {
    throw new Error(`Gagal mengunduh media WhatsApp: ${err.message}`);
  }
}

async function downloadWhatsAppMediaFrames(message, media) {
  let rawBuffer = null;
  if (media?.path && fs.existsSync(media.path)) {
    rawBuffer = fs.readFileSync(media.path);
  } else if (Buffer.isBuffer(media?.buffer)) {
    rawBuffer = media.buffer;
  } else {
    const ctx = getContextInfo(message);
    const isDirectMedia = Boolean(message?.message?.imageMessage || message?.message?.videoMessage || message?.message?.stickerMessage);
    const isQuotedMedia = Boolean(ctx?.quotedMessage?.imageMessage || ctx?.quotedMessage?.videoMessage || ctx?.quotedMessage?.stickerMessage || ctx?.quotedMessage?.viewOnceMessage?.message?.imageMessage);

    if (isDirectMedia || isQuotedMedia) {
      let targetMsg = message;
      if (isQuotedMedia && ctx?.stanzaId) {
        targetMsg = {
          key: {
            remoteJid: message.key.remoteJid,
            id: ctx.stanzaId,
            participant: ctx.participant || ctx.remoteJid
          },
          message: ctx.quotedMessage
        };
      }
      rawBuffer = await downloadWhatsAppMedia(targetMsg, "buffer");
    }
  }

  if (!rawBuffer) return null;
  const frames = await extractMultiFramesForAi(rawBuffer, 3);
  return frames.map(f => f.toString("base64"));
}

async function buildUserContent(prompt, message, media) {
  const text = String(prompt || "").trim() || "Jelaskan media ini singkat dan jelas ya.";
  const b64Frames = await downloadWhatsAppMediaFrames(message, media);

  if (!b64Frames || !b64Frames.length) return text;

  const content = [{ type: "text", text }];
  for (const b64 of b64Frames) {
    content.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${b64}` }
    });
  }
  return content;
}

function headers(apiKey, stream) {
  const h = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "User-Agent": "Axynity-WA-Bot/1.0"
  };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}
function isHtml(body = "", contentType = "") {
  const s = String(body || "").trim().toLowerCase();
  return String(contentType || "").toLowerCase().includes("text/html") || s.startsWith("<!doctype html") || s.startsWith("<html") || s.includes("<title>cloudflare");
}
function safeHttpError(status, body, contentType) {
  if (isHtml(body, contentType)) {
    const e = new Error(`Axynity gateway sedang bermasalah (HTTP ${status}).`); e.code = "AXYNITY_GATEWAY_HTML"; e.status = status; return e;
  }
  try {
    const d = JSON.parse(body || "{}");
    const msg = d?.error?.message || d?.message;
    if (msg) { const e = new Error(String(msg)); e.status = status; return e; }
  } catch {}
  const e = new Error(`Axynity API HTTP ${status}.`); e.status = status; return e;
}
async function doAxynityRequest({ baseUrl, model, messages, apiKey, timeoutMs, stream = true, includeModel = true }) {
  const payloadMessages = messages[0]?.role === "system" ? messages : [SYSTEM_PROMPT, ...messages];
  const payload = { stream, messages: payloadMessages };
  if (includeModel && model) payload.model = model;
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: headers(apiKey, stream),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
}
async function parseNonStreamResponse(r, { log, jid, sessionId, model }) {
  const body = await r.text().catch(() => "");
  const ct = r.headers.get("content-type") || "";
  if (!r.ok) {
    log?.("ai_nonstream_error", { jid, sessionId, status: r.status, contentType: ct, body: body.slice(0, 1600) });
    throw safeHttpError(r.status, body, ct);
  }
  if (isHtml(body, ct)) {
    log?.("ai_nonstream_html", { jid, sessionId, status: r.status, contentType: ct, body: body.slice(0, 1600) });
    throw safeHttpError(r.status, body, ct);
  }
  let data;
  try { data = JSON.parse(body); }
  catch { throw new Error("Axynity non-stream mengirim JSON tidak valid."); }
  const answer = stripHiddenReasoning(data?.choices?.[0]?.message?.content || data?.message?.content || data?.text || "");
  if (!answer) throw new Error("Axynity non-stream tidak mengirim jawaban.");
  log?.("ai_response", { jid, sessionId, model, stream: false, text: answer });
  return answer;
}

async function askAxynityStream({ messages, log, jid, sessionId, hasImage, onVisibleText, onThinking }) {
  const baseUrl = String(process.env.AXYNITY_BASE_URL || process.env.NERA_AI_BASE_URL || "http://170.39.194.189:4123").replace(/\/+$/, "");
  const model = String(process.env.AXYNITY_MODEL || process.env.NERA_AI_MODEL || "axynity").trim() || "axynity";

  if (!AXYNITY_API_KEY) {
    throw new Error("AXYNITY_API_KEY belum di-set di environment.");
  }

  const timeoutMs = hasImage ? IMAGE_TIMEOUT_MS : TEXT_TIMEOUT_MS;
  log?.("ai_request", { jid, sessionId, model, stream: true, hasImage, timeoutMs, historyMessages: Math.max(0, messages.length - 1) });

  let r = await doAxynityRequest({ baseUrl, model, messages, apiKey: AXYNITY_API_KEY, timeoutMs, stream: true, includeModel: true });
  if (r.status === 403) {
    const b = await r.text().catch(() => "");
    log?.("ai_403", { jid, sessionId, withModel: true, contentType: r.headers.get("content-type") || "", body: b.slice(0, 1200) });
    r = await doAxynityRequest({ baseUrl, model, messages, apiKey: AXYNITY_API_KEY, timeoutMs, stream: true, includeModel: false });
  }

  if (!r.ok || (r.headers.get("content-type") || "").toLowerCase().includes("text/html")) {
    const b = await r.text().catch(() => "");
    const ct = r.headers.get("content-type") || "";
    log?.("ai_stream_fallback", { jid, sessionId, status: r.status, contentType: ct, html: isHtml(b, ct), body: b.slice(0, 1600) });

    let fallback = await doAxynityRequest({ baseUrl, model, messages, apiKey: AXYNITY_API_KEY, timeoutMs, stream: false, includeModel: true });
    if (fallback.status === 403) {
      const fb = await fallback.text().catch(() => "");
      log?.("ai_nonstream_403", { jid, sessionId, withModel: true, body: fb.slice(0, 1200) });
      fallback = await doAxynityRequest({ baseUrl, model, messages, apiKey: AXYNITY_API_KEY, timeoutMs, stream: false, includeModel: false });
    }
    const answer = await parseNonStreamResponse(fallback, { log, jid, sessionId, model });
    onVisibleText?.(answer);
    return answer;
  }

  if (!r.body) throw new Error("Axynity SSE tidak mengirim response body.");
  const reader = r.body.getReader(); const decoder = new TextDecoder();
  let buffer = "", raw = "";
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, i); buffer = buffer.slice(i + 2);
      const { event, data } = parseSseBlock(block);
      if (!data || data === "[DONE]") continue;
      if (event === "thinking" || event === "reasoning") { onThinking?.(); continue; }
      const piece = extractSseText(data); if (!piece.text) continue;
      raw = piece.type === "full" ? piece.text : raw + piece.text;
      const visible = stripHiddenReasoning(raw); if (visible) onVisibleText?.(visible); else onThinking?.();
    }
  }
  const answer = stripHiddenReasoning(raw);
  if (!answer) throw new Error("Axynity tidak mengirim balasan yang bisa ditampilkan.");
  log?.("ai_response", { jid, sessionId, model, stream: true, text: answer });
  return answer;
}

export async function onLidMapping({ mapping, log }) { migrateAlias(mapping?.pn, mapping?.lid, log); }
export async function onChatDelete({ jid, log }) { resetSessionsForChat(jid, log); }
export async function onMessagesDelete({ event, log }) { if (event?.jid && event?.all === true) resetSessionsForChat(event.jid, log); }

export default async function axynityPlugin({ sock, message, media, log }) {
  const jid = message?.key?.remoteJid;
  if (!jid || message?.key?.fromMe || jid === "status@broadcast") return;
  const raw = String(getText(message)).trim();

  const ctx = getContextInfo(message);
  const quotedMsg = ctx?.quotedMessage;

  const hasDirectImage = Boolean(message?.message?.imageMessage);
  const hasDirectVideo = Boolean(message?.message?.videoMessage);
  const hasQuotedImage = Boolean(quotedMsg?.imageMessage || quotedMsg?.viewOnceMessage?.message?.imageMessage);
  const hasQuotedVideo = Boolean(quotedMsg?.videoMessage);
  const hasImage = hasDirectImage || hasQuotedImage || hasDirectVideo || hasQuotedVideo || media?.type === "image" || media?.type === "video";
  const hasSticker = Boolean(message?.message?.stickerMessage);

  const isAnimatedMedia = Boolean(
    hasDirectVideo ||
    hasQuotedVideo ||
    message?.message?.videoMessage?.gifPlayback ||
    quotedMsg?.videoMessage?.gifPlayback ||
    message?.message?.stickerMessage?.isAnimated ||
    quotedMsg?.stickerMessage?.isAnimated
  );

  const lower = raw.toLowerCase();
  const info = getIdentity(message);
  const session = getSession(info);

  if (session?.pendingImageTimestamp && Date.now() - session.pendingImageTimestamp > 10 * 60 * 1000) {
    delete session.pendingImageB64;
    delete session.pendingIsAnimated;
    delete session.awaitingStickerConfirm;
    delete session.pendingImageTimestamp;
    saveStore();
  }

  // REAKSI EMOSI DINAMIS (SMART SENTIMENT REACTION)
  if (/\b(sedih|nangis|kecewa|gagal|sakit|patah hati|galau|duka)\b/i.test(lower)) {
    await sock.sendMessage(jid, { react: { text: "😢", key: message.key } }).catch(() => {});
  } else if (/\b(marah|kesel|benci|anjing|babi|kontol|tai|bangsat|goblok|emosi)\b/i.test(lower)) {
    await sock.sendMessage(jid, { react: { text: "😡", key: message.key } }).catch(() => {});
  } else if (/\b(kaget|anjir|astaga|woy|serius|demi apa|anjay)\b/i.test(lower)) {
    await sock.sendMessage(jid, { react: { text: "😲", key: message.key } }).catch(() => {});
  } else if (/\b(wkwk|hahaha|lol|lucu|ngakak|gokil)\b/i.test(lower)) {
    await sock.sendMessage(jid, { react: { text: "😂", key: message.key } }).catch(() => {});
  } else if (/\b(keren|mantap|good|hebat|pro|solusi|juara)\b/i.test(lower)) {
    await sock.sendMessage(jid, { react: { text: "🔥", key: message.key } }).catch(() => {});
  } else if (/\b(terima kasih|makasih|thanks|thx|tq)\b/i.test(lower)) {
    await sock.sendMessage(jid, { react: { text: "👍", key: message.key } }).catch(() => {});
  }

  // DETEKSI LID BARU DAN NOTIFIKASI OWNER
  if (isLid(info.identity) && !store.registeredLids.includes(info.identity)) {
    store.registeredLids.push(info.identity);
    saveStore();

    const selfJid = OWNER_JID || (sock?.user?.id ? sock.user.id.split(":")[0] + "@s.whatsapp.net" : null);
    if (selfJid) {
      const notifyText = `🔔 *User Baru (LID) Terdeteksi!*\n\n• *LID User:* ${info.identity}\n• *Chat JID:* ${jid}\n• *Pesan Awal:* "${raw || "[Media]"}"`;
      await sock.sendMessage(selfJid, { text: notifyText }).catch((err) => {
        log?.("notify_self_error", { error: err.message });
      });
    }
  }

  // 1. FITUR KOMENTAR STIKER SPONTAN (MULTI-FRAME DETEKSI GERAKAN)
  if (hasSticker) {
    let placeholder = null, frame = 0, timer = null;
    const stopAnim = () => { if (timer) clearInterval(timer); timer = null; };

    try {
      placeholder = await sock.sendMessage(jid, { text: "🖼️ Axynity mendeteksi stiker..." }, { quoted: message }).catch(() => null);

      timer = setInterval(() => {
        if (!placeholder?.key) return;
        frame = (frame + 1) % 3;
        void sock.sendMessage(jid, { text: `🖼️ Axynity mendeteksi stiker${".".repeat(frame + 1)}`, edit: placeholder.key }).catch(() => {});
      }, THINK_ANIMATION_MS);
      timer.unref?.();

      const stickerBuffer = await downloadWhatsAppMedia(message, "buffer");
      if (stickerBuffer) {
        const frames = await extractMultiFramesForAi(stickerBuffer, 3);
        const stickerContent = [
          { type: "text", text: "User mengirim stiker ini di chat. Amati beberapa frame gerakan stiker ini. Berikan komentar singkat dan santai (1 kalimat seperti: 'Mantap stickernya, gerakan [objek]... 😎'). Sampaikan dengan santai layaknya teman." }
        ];

        for (const f of frames) {
          stickerContent.push({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${f.toString("base64")}` }
          });
        }

        const commentMessages = [{ role: "user", content: stickerContent }];
        const comment = await askAxynityStream({ messages: commentMessages, log, jid, sessionId: "sticker-comment", hasImage: true });

        stopAnim();

        if (comment && placeholder?.key) {
          await sock.sendMessage(jid, { text: comment, edit: placeholder.key }).catch(() => {});
        } else if (comment) {
          await sock.sendMessage(jid, { text: comment }, { quoted: message });
        }
      } else {
        stopAnim();
        if (placeholder?.key) {
          await sock.sendMessage(jid, { text: "Gagal membaca stikernya nih 😅", edit: placeholder.key }).catch(() => {});
        }
      }
    } catch (e) {
      stopAnim();
      log?.("sticker_comment_error", { error: e.message });
      if (placeholder?.key) {
        await sock.sendMessage(jid, { text: "Gagal mendeteksi stikernya nih 😅", edit: placeholder.key }).catch(() => {});
      }
    }
    return;
  }

  // 2. DETEKSI BUAT STIKER (MEDIA MASUK CHAT DULU BARU REVIEW AI)
  const isExplicitStickerCommand = (hasImage && /\b(sticker|stiker)\b/i.test(raw)) || (hasQuotedImage && /\b(sticker|stiker)\b/i.test(raw));
  const isConfirmPattern = /^(?:iya|ya|boleh|mau|ok|yep|gas|bikin|jadikan|silahkan|acc|pikirin|stiker|sticker)\b/i.test(lower) || /\b(jadikan stiker|bikin stiker|buat stiker)\b/i.test(lower);
  const hasPendingSticker = Boolean(session?.awaitingStickerConfirm && session?.pendingImageB64);

  if (/\b(jadikan stiker|bikin stiker|buat stiker)\b/i.test(lower) && !hasImage && !hasPendingSticker) {
    await sock.sendMessage(jid, { text: "Mana gambarnya nih? Kirim gambar/GIF/video dulu atau reply (balas) medianya dengan ketik 'stiker' ya! 🎨👍" }, { quoted: message });
    return;
  }

  if (isExplicitStickerCommand || (hasPendingSticker && isConfirmPattern)) {
    let placeholder = null, frame = 0, timer = null;
    const stopAnim = () => { if (timer) clearInterval(timer); timer = null; };

    try {
      placeholder = await sock.sendMessage(jid, { text: "⏳ Sedang membuat stiker..." }, { quoted: message }).catch(() => null);

      timer = setInterval(() => {
        if (!placeholder?.key) return;
        frame = (frame + 1) % 3;
        void sock.sendMessage(jid, { text: `⏳ Sedang membuat stiker${".".repeat(frame + 1)}`, edit: placeholder.key }).catch(() => {});
      }, THINK_ANIMATION_MS);
      timer.unref?.();

      let mediaBuffer = null;
      let shouldAnimate = isAnimatedMedia;

      if (hasDirectImage || hasDirectVideo || media?.type === "image" || media?.type === "video") {
        mediaBuffer = await downloadWhatsAppMedia(message, "buffer");
      } else if ((hasQuotedImage || hasQuotedVideo) && ctx?.stanzaId) {
        const targetMsg = {
          key: {
            remoteJid: message.key.remoteJid,
            id: ctx.stanzaId,
            participant: ctx.participant || ctx.remoteJid
          },
          message: quotedMsg
        };
        mediaBuffer = await downloadWhatsAppMedia(targetMsg, "buffer");
      } else if (session?.pendingImageB64) {
        mediaBuffer = Buffer.from(session.pendingImageB64, "base64");
        shouldAnimate = Boolean(session.pendingIsAnimated);
      }

      if (mediaBuffer) {
        const webpBuffer = await convertMediaToWebp(mediaBuffer, shouldAnimate);

        // SEND STICKER FIRST INTO CHAT ROOM
        await sock.sendMessage(jid, { sticker: webpBuffer }, { quoted: message });
        await sock.sendMessage(jid, { react: { text: "🔥", key: message.key } }).catch(() => {});

        delete session.pendingImageB64;
        delete session.pendingIsAnimated;
        delete session.awaitingStickerConfirm;
        delete session.pendingImageTimestamp;
        saveStore();

        // MULTI-FRAME REVIEW FOR AI
        const frames = await extractMultiFramesForAi(mediaBuffer, 3);
        const promptContent = [
          { type: "text", text: "Stiker dari media ini baru saja berhasil kamu buat dan dikirim ke room chat. Amati beberapa frame gerakan ini dan berikan pesan santai singkat 1 kalimat (contoh: 'Stickernya udah jadi nih! Gambar/gerakan [sebutkan objek] 👍...')." }
        ];

        for (const f of frames) {
          promptContent.push({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${f.toString("base64")}` }
          });
        }

        const aiResponse = await askAxynityStream({
          messages: [{ role: "user", content: promptContent }],
          log,
          jid,
          sessionId: "sticker-make-comment",
          hasImage: true
        });

        stopAnim();

        if (aiResponse && placeholder?.key) {
          await sock.sendMessage(jid, { text: aiResponse, edit: placeholder.key }).catch(() => {});
        } else if (placeholder?.key) {
          await sock.sendMessage(jid, { text: "Stickernya udah jadi nih! 👍", edit: placeholder.key }).catch(() => {});
        }
        return;
      } else {
        throw new Error("Buffer media tidak ditemukan.");
      }
    } catch (e) {
      stopAnim();
      delete session.pendingImageB64;
      delete session.pendingIsAnimated;
      delete session.awaitingStickerConfirm;
      delete session.pendingImageTimestamp;
      saveStore();
      const errText = `❌ Gagal buat stiker: ${e.message}`;
      if (placeholder?.key) {
        await sock.sendMessage(jid, { text: errText, edit: placeholder.key }).catch(() => {});
      } else {
        await sock.sendMessage(jid, { text: errText }, { quoted: message }).catch(() => {});
      }
      return;
    }
  }

  // 3. GAMBAR/GIF/VIDEO TANPA TEKS -> DETEKSI MULTI-FRAME & TANYA STIKER
  if ((hasDirectImage || hasDirectVideo) && !raw && !isExplicitStickerCommand) {
    let placeholder = null, frame = 0, timer = null;
    const stopAnim = () => { if (timer) clearInterval(timer); timer = null; };

    try {
      placeholder = await sock.sendMessage(jid, { text: "🖼️ Axynity mendeteksi media..." }, { quoted: message }).catch(() => null);

      timer = setInterval(() => {
        if (!placeholder?.key) return;
        frame = (frame + 1) % 3;
        void sock.sendMessage(jid, { text: `🖼️ Axynity mendeteksi media${".".repeat(frame + 1)}`, edit: placeholder.key }).catch(() => {});
      }, THINK_ANIMATION_MS);
      timer.unref?.();

      let mediaBuffer = await downloadWhatsAppMedia(message, "buffer");
      if (!mediaBuffer && media?.path && fs.existsSync(media.path)) {
        mediaBuffer = fs.readFileSync(media.path);
      }
      if (!mediaBuffer && Buffer.isBuffer(media?.buffer)) {
        mediaBuffer = media.buffer;
      }

      if (mediaBuffer) {
        const frames = await extractMultiFramesForAi(mediaBuffer, 3);

        session.pendingImageB64 = mediaBuffer.toString("base64");
        session.pendingIsAnimated = isAnimatedMedia;
        session.pendingImageTimestamp = Date.now();
        session.awaitingStickerConfirm = true;
        saveStore();

        const promptContent = [
          { type: "text", text: "Lihat media ini dari beberapa frame berikut. Sebutkan nama/objek utama atau gerakan di media ini secara singkat dalam 2-4 kata (contoh: 'kucing persia', 'gif anime joget'). Jawab ringkas." }
        ];

        for (const f of frames) {
          promptContent.push({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${f.toString("base64")}` }
          });
        }

        const detectedObject = await askAxynityStream({
          messages: [{ role: "user", content: promptContent }],
          log,
          jid,
          sessionId: "image-detect",
          hasImage: true
        });

        stopAnim();

        const objectText = detectedObject ? detectedObject.trim() : "ini";
        const questionText = `Wih media ${objectText} nih! Mau aku jadiin stiker WhatsApp sekalian nggak? Kalo mau, tinggal bales 'iya' atau 'boleh' ya! 🎨👍`;

        if (placeholder?.key) {
          await sock.sendMessage(jid, { text: questionText, edit: placeholder.key }).catch(() => {});
        } else {
          await sock.sendMessage(jid, { text: questionText }, { quoted: message });
        }
        return;
      } else {
        stopAnim();
        if (placeholder?.key) {
          await sock.sendMessage(jid, { text: "Gagal membaca medianya nih 😅", edit: placeholder.key }).catch(() => {});
        }
      }
    } catch (e) {
      stopAnim();
      log?.("image_detect_error", { error: e.message });
      if (placeholder?.key) {
        await sock.sendMessage(jid, { text: "Gagal mendeteksi medianya nih 😅", edit: placeholder.key }).catch(() => {});
      }
    }
  }

  if (!raw && !hasImage) return;

  if (!hasImage && /^\.(?:new|reset|newchat|lupain)\s*$/i.test(raw)) {
    delete store.sessions[info.key]; store.sessions[info.key] = newSession(info); saveStore();
    await sock.sendMessage(jid, { text: "🆕 Sesi obrolan baru udah dibuat. Yuk mulai lagi! 👍" }, { quoted: message }); return;
  }

  const cmd = raw.match(/^(?:\.ai|ai)\s+([\s\S]+)/i);
  const autoReply = String(process.env.WA_AI_AUTO_REPLY || "true").toLowerCase() !== "false";

  if (!hasImage && !cmd && (!autoReply || lower === "ping" || raw.startsWith("."))) return;
  if (hasImage && !cmd && !raw && !autoReply) return;

  const prompt = cmd ? cmd[1].trim() : (raw || "Jelaskan media ini singkat dan jelas ya.");

  let userContent;
  try {
    userContent = await buildUserContent(prompt, message, media);
  } catch (e) {
    await sock.sendMessage(jid, { text: e.message }, { quoted: message }).catch(() => {});
    return;
  }

  const messages = trimMessages([...(session.messages || []).map(m => ({ role: m.role, content: m.content })), { role: "user", content: userContent }]);
  let placeholder = null, lastEditAt = 0, lastRendered = "", visibleStarted = false, frame = 0, timer = null;
  const stopAnim = () => { if (timer) clearInterval(timer); timer = null; };

  let socketAlive = true;
  const safeSend = async (payload) => {
    if (!socketAlive) return false;
    try {
      await sock.sendMessage(jid, payload, payload.edit ? undefined : { quoted: message });
      return true;
    } catch (e) {
      const msg = String(e?.message || e);
      if (/connection closed|not connected|timed out|stream errored/i.test(msg)) socketAlive = false;
      log?.("ai_send_error", { jid, error: msg });
      return false;
    }
  };

  try {
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    const base = hasImage ? "🖼️ Axynity sedang melihat media" : "🧠 Axynity sedang berpikir";
    placeholder = await sock.sendMessage(jid, { text: `${base}...` }, { quoted: message }).catch((e) => {
      log?.("ai_placeholder_error", { jid, error: e?.message });
      return null;
    });
    timer = setInterval(() => {
      if (!placeholder?.key || visibleStarted || !socketAlive) return;
      frame = (frame + 1) % 3;
      void sock.sendMessage(jid, { text: `${base}${".".repeat(frame + 1)}`, edit: placeholder.key }).catch((e) => {
        const msg = String(e?.message || e);
        if (/connection closed|not connected|timed out|stream errored/i.test(msg)) socketAlive = false;
      });
    }, THINK_ANIMATION_MS); timer.unref?.();

    const render = async (text, force = false) => {
      const clean = stripHiddenReasoning(text); if (!clean || clean === lastRendered) return true;
      visibleStarted = true; stopAnim();
      if (!force && Date.now() - lastEditAt < STREAM_EDIT_MS) return true;
      lastEditAt = Date.now(); lastRendered = clean;
      if (placeholder?.key) {
        const ok = await safeSend({ text: clean, edit: placeholder.key });
        if (ok) return true;
      }
      return safeSend({ text: clean });
    };

    const answer = await askAxynityStream({ messages, log, jid, sessionId: session.id, hasImage, onVisibleText: v => void render(v), onThinking: () => {} });
    const rendered = await render(answer, true);
    if (!rendered) throw new Error("Jawaban Axynity diterima, tetapi gagal dikirim ke WhatsApp (koneksi mungkin terputus).");

    session.messages = trimMessages([...(session.messages || []), { role: "user", content: Array.isArray(userContent) ? `[Media] ${prompt}` : prompt }, { role: "assistant", content: answer }]);
    session.updatedAt = Date.now(); session.chatJids = [...new Set([...(session.chatJids || []), jid, info.identity].filter(Boolean))]; saveStore();
  } catch (e) {
    stopAnim();
    const err = e?.message || String(e);
    log?.("ai_error", { jid, identity: info.identity, sessionId: session.id, status: e?.status || null, code: e?.code || null, error: err, text: prompt, hasImage });
    console.error("[axynity-plugin]", err);
    let friendly = "Axynity lagi ada kendala sebentar, coba lagi nanti ya!";
    if (e?.code === "AXYNITY_GATEWAY_HTML") friendly = `Gateway Axynity lagi bermasalah (HTTP ${e.status || "?"}). Coba lagi nanti!`;
    else if (e?.status === 403 || err.includes("403")) friendly = "Request Axynity ditolak (403). Cek API key atau Cloudflare.";
    else if (!AXYNITY_API_KEY) friendly = "API key bot belum di-set. Hubungi admin ya.";
    else if (/timed out|abort/i.test(err)) friendly = hasImage ? "Analisis media kelamaan, coba pakai file yang lebih kecil." : "Axynity kelamaan merespons, coba lagi ya.";

    let sent = false;
    if (placeholder?.key && socketAlive) {
      sent = await safeSend({ text: friendly, edit: placeholder.key });
    }
    if (!sent && socketAlive) await safeSend({ text: friendly });
  } finally {
    stopAnim(); await sock.sendPresenceUpdate("paused", jid).catch(() => {});
  }
}
