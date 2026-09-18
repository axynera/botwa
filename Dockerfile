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

EXPOSE 8000

CMD ["npm", "start"]
