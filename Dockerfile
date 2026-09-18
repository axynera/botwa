FROM node:22-alpine

WORKDIR /app

# Baileys dapat membutuhkan git untuk dependency tertentu. Chromium/Puppeteer sudah tidak dipakai.
RUN apk add --no-cache git ca-certificates ffmpeg

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8000

# Default Koyeb/runtime configuration.
# Secrets (WA_ADMIN_KEY and NERA_AI_API_KEY) remain external environment variables.
ENV WA_AUTO_READ=true
ENV WA_AI_AUTO_REPLY=true
ENV WA_SESSION_DIR=/data/axynera-wa-session
ENV WA_AUTO_DOWNLOAD_IMAGES=true
ENV WA_AUTO_ONLINE=true
ENV WA_PRESENCE_INTERVAL_MS=60000
ENV WA_ABOUT_UPDATE_MS=60000
ENV WA_ABOUT_FORCE_REFRESH_MS=300000
ENV WA_ABOUT_PREFIX="🤖 Axynera Ai⌚ Aktif"
ENV NERA_AI_BASE_URL=https://api.axynera.my.id
ENV NERA_AI_MODEL=Nera-Plus.5
ENV NERA_AI_DEFAULT_MODE=cepat
ENV NERA_AI_TIMEOUT_MS=120000
ENV NERA_AI_STREAM_EDIT_MS=1200
ENV NERA_AI_THINK_ANIMATION_MS=900
ENV NERA_AI_MAX_IMAGE_BYTES=8388608
ENV NERA_AI_MEMORY_TURNS=20
ENV WA_STICKER_MAX_INPUT_BYTES=12582912
ENV WA_STICKER_MAX_OUTPUT_BYTES=500000
ENV WA_STICKER_MAX_SECONDS=6

EXPOSE 8000

CMD ["npm", "start"]
