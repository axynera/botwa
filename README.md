# 📱 Axynera WhatsApp Bot

Runtime WhatsApp berbasis **Baileys** dengan QR login, session persistent, auto-read, auto reconnect, Plugin Manager, Live Console, Nera AI, SSE pseudo-streaming ke edit message WhatsApp, memory per user/LID, auto download gambar, online presence, dan About uptime otomatis.

## ✨ Fitur utama

- 📲 QR WhatsApp di `/wa`
- 💾 Session persistent lewat `WA_SESSION_DIR`
- 👁️ Auto-read pesan masuk
- ♻️ Auto reconnect WhatsApp
- 🟢 Auto presence online
- ⌚ About otomatis: `🤖 Axynera Ai⌚ Aktif ...`
- 🖼️ Auto-download gambar masuk
- 🧩 Plugin `.js` / `.mjs` dengan hot reload
- 🖥️ Live Console
- 🔐 Plugin Manager + Console dilindungi `WA_ADMIN_KEY`
- 🤖 Nera API: `https://api.axynera.my.id/v1/chat/completions`
- ⚡ Mode `.mode cepat`
- 🧠 Mode `.mode pintar`
- 🌊 SSE `stream:true` lalu pesan WhatsApp diedit berkala
- 🧠 Memory percakapan per user, prioritas LID
- 🆕 `.new`, `.reset`, `.newchat`, `.lupain` untuk sesi baru
- 🗑️ Memory di-reset jika event hapus chat diterima Baileys
- ❤️ `/health`, `/uptime`, `/ping`

## 🔐 Environment Variables

Jangan menyimpan API key asli di GitHub.

```env
PORT=8000
HOST=0.0.0.0

WA_ADMIN_KEY=ganti-dengan-key-admin-yang-kuat

# WhatsApp
WA_AUTO_READ=true
WA_AI_AUTO_REPLY=true
WA_SESSION_DIR=/data/axynera-wa-session
WA_PLUGIN_RELOAD_MS=5000
WA_CONSOLE_MAX_LOGS=500

# Media
WA_AUTO_DOWNLOAD_IMAGES=true
# WA_MEDIA_DIR=/data/axynera-wa-session/media

# Presence + About
WA_AUTO_ONLINE=true
WA_PRESENCE_INTERVAL_MS=60000
WA_ABOUT_UPDATE_MS=60000
WA_ABOUT_PREFIX=🤖 Axynera Ai⌚ Aktif

# Nera AI
NERA_AI_BASE_URL=https://api.axynera.my.id
NERA_AI_MODEL=Nera-Plus.5
NERA_AI_DEFAULT_MODE=cepat
NERA_AI_TIMEOUT_MS=120000
NERA_AI_STREAM_EDIT_MS=1200
NERA_AI_API_KEY=

# Memory
NERA_AI_MEMORY_TURNS=20
# NERA_AI_MEMORY_FILE=/data/axynera-wa-session/nera-memory.json

BODY_LIMIT_BYTES=2097152
KEEP_ALIVE_TIMEOUT_MS=75000
```

> Jika environment Koyeb masih memiliki variable lama, nilai Koyeb akan mengalahkan `.env.example`. Hapus variable `NEXTURA_AI_*` lama dan gunakan hanya `NERA_AI_*` di atas.

## 🤖 Request Nera

Bot memakai endpoint:

```text
POST https://api.axynera.my.id/v1/chat/completions
```

Payload utama:

```json
{
  "model": "Nera-Plus.5",
  "mode": "cepat",
  "stream": true,
  "messages": [
    { "role": "user", "content": "Halo" }
  ]
}
```

Jika request dengan model mendapat HTTP 403, plugin memiliki retry kompatibilitas tanpa memaksa field `model`, sambil mencatat body error ke Live Console.

## ⚡🧠 Mode AI

```text
.mode
.mode cepat
.mode pintar
```

Mode disimpan bersama sesi percakapan user.

## 🧠 Memory per user / LID

Memory disimpan default di:

```text
/data/axynera-wa-session/nera-memory.json
```

Bot memprioritaskan identitas WhatsApp **LID** bila tersedia, lalu melakukan fallback ke JID/nomor. Mapping PN ↔ LID dimigrasikan supaya history tidak pecah ketika format identitas berubah.

Default maksimum:

```env
NERA_AI_MEMORY_TURNS=20
```

Artinya konteks terbaru dibatasi agar request AI tidak membesar tanpa batas.

## 🌊 SSE di WhatsApp

Nera tetap memakai SSE nyata di backend. WhatsApp tidak menampilkan token stream secara native, sehingga bot membuat efek streaming dengan cara:

```text
Nera SSE → kumpulkan delta → edit satu pesan WhatsApp berkala → jawaban final
```

Interval edit default:

```env
NERA_AI_STREAM_EDIT_MS=1200
```

Jawaban final yang lengkap saja yang disimpan ke memory.

## 👁️ Auto-read

Default:

```env
WA_AUTO_READ=true
```

Pesan live masuk ditandai sudah dibaca sebelum plugin memprosesnya.

## 🖼️ Download gambar

Default:

```env
WA_AUTO_DOWNLOAD_IMAGES=true
```

Gambar masuk disimpan ke folder media di dalam session persistent. Informasi file juga diteruskan ke plugin sehingga bisa dipakai untuk integrasi Nera Vision berikutnya.

## 🟢 Presence & About uptime

Default:

```env
WA_AUTO_ONLINE=true
WA_PRESENCE_INTERVAL_MS=60000
WA_ABOUT_UPDATE_MS=60000
WA_ABOUT_PREFIX=🤖 Axynera Ai⌚ Aktif
```

Contoh About:

```text
🤖 Axynera Ai⌚ Aktif 2 Menit
🤖 Axynera Ai⌚ Aktif 1 Jam 7 Menit
```

## 🌐 Endpoint

```text
GET  /
GET  /wa
GET  /wa/status
POST /wa/restart
POST /wa/logout

GET  /plugins
GET  /console

GET    /api/plugins
POST   /api/plugins
GET    /api/plugins/:name
DELETE /api/plugins/:name

GET    /api/console
DELETE /api/console

GET /health
GET /health-1
GET /health-2
GET /health-3
GET /health/1
GET /health/2
GET /health/3

GET /uptime
GET /uptime-1
GET /uptime-2
GET /uptime-3
GET /uptime/1
GET /uptime/2
GET /uptime/3

GET /ping
```

## 💾 Persistent volume

Gunakan volume `/data` dan set:

```env
WA_SESSION_DIR=/data/axynera-wa-session
```

Folder ini menyimpan auth WhatsApp, memory Nera, dan media yang diunduh. Selama volume tetap tersedia, bot dapat memakai session lama setelah restart/redeploy tanpa scan QR ulang.

## 🚀 Menjalankan

Node.js minimum **22**.

```bash
npm install
npm run check
npm start
```

Untuk hosting seperti Koyeb:

```text
Start command : npm start
Health check  : /health
Port          : PORT, default 8000
```

## 📁 Struktur

```text
start.js               bootstrap Axynera session path
sdk-compat.js          web server, QR, Plugin Manager, Live Console, health/uptime
whatsapp-bot.js        Baileys, auto-read, presence, media, reconnect, plugin loader
live-console.js        ring buffer Live Console
wa-plugins/
├── ping.js
└── ai-chat.js         Nera SSE + mode + memory per LID/JID
```

## 🔒 Keamanan

- Jangan commit API key.
- Gunakan `WA_ADMIN_KEY` panjang dan acak.
- Jangan bagikan akses `/plugins` atau `/console` beserta admin key.
- Live Console dapat memuat percakapan WhatsApp.
- Plugin berjalan di proses Node.js bot, jadi hanya pasang kode yang dipercaya.
- Baileys bukan API resmi WhatsApp; gunakan secara wajar dan hindari spam/bulk messaging.

---

**Axynera WhatsApp Bot + Nera AI** 🚀


## Appwrite persistent storage

The bot can keep WhatsApp session data and runtime plugins outside the Koyeb container using Appwrite Storage. Uploaded user media used by the bot is stored temporarily in Appwrite and automatically expires.

Set these Koyeb environment variables:
- `APPWRITE_ENDPOINT`
- `APPWRITE_PROJECT_ID`
- `APPWRITE_API_KEY`
- `APPWRITE_BUCKET_ID` (default: `botwa`)

The server API key needs Storage bucket/file read, write, and delete permissions. The bot creates the bucket automatically when it does not exist.

Appwrite folders:
- `plugins/` — runtime plugins; Appwrite is the source of truth.
- `session/` — Baileys session backup.
- `temp/` — temporary user media; automatically cleaned up.

After the first initialization, upload or remove `.js`/`.mjs` plugins directly in the Appwrite `plugins/` folder. The bot periodically syncs them without rebuilding the Docker image.
