import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { uploadTemporaryBuffer, deleteTemporaryFile } from "../appwrite-storage.js";

const SESSION_DIR = path.resolve(process.env.WA_SESSION_DIR || "/tmp/axynera-wa-session");
const PENDING_FILE = path.resolve(
  process.env.WA_STICKER_PENDING_FILE || path.join(SESSION_DIR, "sticker-pending.json")
);
const MAX_INPUT_BYTES = Math.max(512000, Number(process.env.WA_STICKER_MAX_INPUT_BYTES || 12 * 1024 * 1024));
const MAX_OUTPUT_BYTES = Math.max(150000, Number(process.env.WA_STICKER_MAX_OUTPUT_BYTES || 500000));
const MAX_SECONDS = Math.max(1, Math.min(10, Number(process.env.WA_STICKER_MAX_SECONDS || 6)));

function loadPending() {
  try {
    if (!fs.existsSync(PENDING_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

const pending = loadPending();
const PENDING_MEDIA_DIR = path.join(SESSION_DIR, "sticker-pending");
fs.mkdirSync(PENDING_MEDIA_DIR, { recursive: true });
function pendingPath(jid) {
  const safe = Buffer.from(String(jid)).toString("base64url").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return path.join(PENDING_MEDIA_DIR, safe);
}
function removePendingMedia(item) {
  try { if (item?.filePath) fs.rmSync(item.filePath, { force: true }); } catch {}
}
async function clearPending(jid) {
  const item = pending[jid];
  if (!item) return;
  removePendingMedia(item);
  delete pending[jid];
  savePending();
}

function savePending() {
  fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
  const tmp = `${PENDING_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pending, null, 2), "utf8");
  fs.renameSync(tmp, PENDING_FILE);
}

const normalize = (v = "") => String(v || "").trim().toLowerCase();

function getText(message) {
  return String(
    message?.message?.conversation ||
    message?.message?.extendedTextMessage?.text ||
    message?.message?.imageMessage?.caption ||
    message?.message?.videoMessage?.caption ||
    ""
  ).trim();
}

function getContextInfo(message) {
  const m = message?.message;
  return m?.extendedTextMessage?.contextInfo ||
    m?.imageMessage?.contextInfo ||
    m?.videoMessage?.contextInfo ||
    m?.documentMessage?.contextInfo ||
    null;
}

function mediaInfo(message) {
  const ctx = getContextInfo(message);
  const quoted = ctx?.quotedMessage;

  const directImage = Boolean(message?.message?.imageMessage);
  const directVideo = Boolean(message?.message?.videoMessage);
  const quotedImage = Boolean(quoted?.imageMessage || quoted?.viewOnceMessage?.message?.imageMessage);
  const quotedVideo = Boolean(quoted?.videoMessage || quoted?.viewOnceMessage?.message?.videoMessage);

  if (directImage) {
    return { kind: "image", animated: false, target: message };
  }
  if (directVideo) {
    return {
      kind: "video",
      animated: true,
      target: message
    };
  }
  if (quotedImage || quotedVideo) {
    return {
      kind: quotedVideo ? "video" : "image",
      animated: quotedVideo,
      target: {
        key: {
          remoteJid: message.key.remoteJid,
          id: ctx?.stanzaId,
          participant: ctx?.participant || ctx?.remoteJid
        },
        message: quoted
      }
    };
  }
  return null;
}

async function downloadMedia(target) {
  const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
  const buffer = await downloadMediaMessage(target, "buffer", {});
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("Media kosong.");
  if (buffer.length > MAX_INPUT_BYTES) {
    throw new Error(`Media terlalu besar. Maksimal ${Math.round(MAX_INPUT_BYTES / 1024 / 1024)} MB.`);
  }
  return buffer;
}

function ffmpeg(buffer, args) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-threads", "1",
      "-i", "pipe:0",
      ...args,
      "-f", "webp",
      "pipe:1"
    ], { stdio: ["pipe", "pipe", "pipe"] });

    const out = [];
    let total = 0;
    let stderr = "";
    let overflow = false;

    ff.stdout.on("data", chunk => {
      total += chunk.length;
      if (total <= MAX_OUTPUT_BYTES + 1024) out.push(chunk);
      else overflow = true;
    });
    ff.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 3000) stderr = stderr.slice(-3000);
    });
    ff.on("error", err => reject(err));
    ff.on("close", code => {
      if (code !== 0) return reject(new Error(stderr.trim() || `FFmpeg exit ${code}`));
      if (overflow) return resolve(null);
      const result = Buffer.concat(out);
      if (!result.length) return reject(new Error("FFmpeg tidak menghasilkan WebP."));
      resolve(result);
    });

    ff.stdin.on("error", () => {});
    ff.stdin.end(buffer);
  });
}

async function imageToSticker(buffer) {
  const variants = [
    ["-frames:v", "1", "-vf", "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000", "-c:v", "libwebp", "-lossless", "0", "-q:v", "80"],
    ["-frames:v", "1", "-vf", "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000", "-c:v", "libwebp", "-lossless", "0", "-q:v", "60"]
  ];

  for (const args of variants) {
    const result = await ffmpeg(buffer, args);
    if (result && result.length <= MAX_OUTPUT_BYTES) return result;
  }
  throw new Error("Gambar tidak bisa dikompres menjadi sticker WebP yang valid.");
}

async function animatedToSticker(buffer) {
  const variants = [
    { seconds: 6, fps: 12, q: 55 },
    { seconds: 6, fps: 10, q: 45 },
    { seconds: 5, fps: 8, q: 40 },
    { seconds: 4, fps: 8, q: 35 }
  ];

  for (const v of variants) {
    const args = [
      "-t", String(v.seconds),
      "-vf", `fps=${v.fps},scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
      "-c:v", "libwebp_anim",
      "-lossless", "0",
      "-q:v", String(v.q),
      "-compression_level", "6",
      "-loop", "0",
      "-an"
    ];
    const result = await ffmpeg(buffer, args);
    if (result && result.length <= MAX_OUTPUT_BYTES) return result;
  }

  throw new Error("Video/GIF terlalu berat untuk animated sticker. Coba video maksimal 6 detik atau lebih kecil.");
}

function isStickerCommand(text) {
  return /^(?:stiker|sticker|buat stiker|bikin stiker|jadikan stiker)\s*$/i.test(text);
}

function isConfirm(text) {
  return /^(?:iya|ya|boleh|mau|ok|oke|okay|yep|gas|bikin|jadikan|stiker|sticker)\s*[.!]?$/i.test(text);
}

function isCancel(text) {
  return /^(?:batal|cancel|nggak|tidak|gak|ga|no)\s*[.!]?$/i.test(text);
}

export default async function stickerPlugin({ sock, message, media, log }) {
  const jid = message?.key?.remoteJid;
  if (!jid || message?.key?.fromMe || jid === "status@broadcast") return;

  const text = getText(message);
  const lower = normalize(text);
  const pendingItem = pending[jid];

  if (pendingItem && Date.now() - pendingItem.createdAt > 10 * 60 * 1000) {
    delete pending[jid];
    savePending();
  }

  // Explicit sticker command tanpa media: claim supaya AI tidak ikut menjawab.
  if (isStickerCommand(text) && !mediaInfo(message)) {
    if (pending[jid]) {
      return await createSticker(jid, message, pending[jid].buffer, pending[jid].animated, sock, log);
    }
    await sock.sendMessage(jid, {
      text: "Kirim/reply gambar, GIF, atau video dulu, lalu ketik 'stiker' ya 🎨"
    }, { quoted: message });
    return true;
  }

  // Konfirmasi hanya dianggap command sticker jika memang ada pending media.
  if (pending[jid] && isConfirm(text)) {
    const item = pending[jid];
    delete pending[jid];
    savePending();
    try {
      const buffer = fs.readFileSync(item.filePath);
      await createSticker(jid, message, buffer, item.animated, sock, log, item.appwriteFileId);
    } finally {
      removePendingMedia(item);
    }
    return true;
  }

  if (pending[jid] && isCancel(text)) {
    await clearPending(jid);
    await sock.sendMessage(jid, { text: "Oke, pembuatan sticker dibatalkan 👍" }, { quoted: message });
    return true;
  }

  const info = mediaInfo(message);
  if (!info) return;

  // Media + caption "stiker" -> langsung convert.
  if (isStickerCommand(text)) {
    await createStickerFromTarget(jid, message, info, sock, log);
    return true;
  }

  // Media tanpa command -> simpan sementara dan minta konfirmasi.
  if (!text) {
    try {
      const buffer = await downloadMedia(info.target);
      const filePath = pendingPath(jid);
      fs.writeFileSync(filePath, buffer);
      const remote = await uploadTemporaryBuffer(
        buffer,
        `sticker-${Date.now()}-${jid}.bin`,
        Number(process.env.APPWRITE_TEMP_TTL_MS || 15 * 60 * 1000)
      ).catch(() => null);
      pending[jid] = {
        filePath,
        appwriteFileId: remote?.id || null,
        animated: info.animated,
        createdAt: Date.now()
      };
      savePending();
      await sock.sendMessage(jid, {
        text: info.animated
          ? "🎬 Videonya sudah diterima. Mau dijadikan animated sticker? Balas 'iya' atau 'stiker'."
          : "🖼️ Gambarnya sudah diterima. Mau dijadikan sticker? Balas 'iya' atau 'stiker'."
      }, { quoted: message });
    } catch (e) {
      log?.("sticker_media_error", { jid, error: e.message });
      await sock.sendMessage(jid, { text: `❌ Gagal membaca media: ${e.message}` }, { quoted: message });
    }
    return true;
  }

  return;
}

async function createStickerFromTarget(jid, message, info, sock, log) {
  try {
    const buffer = await downloadMedia(info.target);
    await createSticker(jid, message, buffer, info.animated, sock, log);
  } catch (e) {
    log?.("sticker_convert_error", { jid, error: e.message });
    await sock.sendMessage(jid, { text: `❌ Gagal membuat sticker: ${e.message}` }, { quoted: message });
  }
}

async function createSticker(jid, message, buffer, animated, sock, log, sourceRemoteId = null) {
  const started = Date.now();
  let placeholder = null;
  let remoteId = sourceRemoteId;
  try {
    if (!remoteId) {
      const remote = await uploadTemporaryBuffer(
        buffer,
        `sticker-source-${Date.now()}.bin`,
        Number(process.env.APPWRITE_TEMP_TTL_MS || 15 * 60 * 1000)
      ).catch(() => null);
      remoteId = remote?.id || null;
    }
    placeholder = await sock.sendMessage(jid, {
      text: animated ? "🎬 Mengubah video/GIF menjadi sticker..." : "🖼️ Membuat sticker..."
    }, { quoted: message }).catch(() => null);

    const webp = animated
      ? await animatedToSticker(buffer)
      : await imageToSticker(buffer);

    await sock.sendMessage(jid, { sticker: webp }, { quoted: message });

    if (pending[jid]) {
      const item = pending[jid];
      delete pending[jid];
      savePending();
      removePendingMedia(item);
    }

    if (placeholder?.key) {
      await sock.sendMessage(jid, {
        text: animated ? "✅ Animated sticker berhasil dibuat!" : "✅ Sticker berhasil dibuat!",
        edit: placeholder.key
      }).catch(() => {});
    }

    log?.("sticker_created", {
      jid,
      animated,
      inputBytes: buffer.length,
      outputBytes: webp.length,
      durationMs: Date.now() - started
    });
  } catch (e) {
    log?.("sticker_convert_error", { jid, animated, error: e.message });
    if (placeholder?.key) {
      await sock.sendMessage(jid, {
        text: `❌ Gagal membuat sticker: ${e.message}`,
        edit: placeholder.key
      }).catch(() => {});
    } else {
      await sock.sendMessage(jid, {
        text: `❌ Gagal membuat sticker: ${e.message}`
      }, { quoted: message }).catch(() => {});
    }
  }
}
