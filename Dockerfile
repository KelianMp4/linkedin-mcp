# Serveur MCP LinkedIn : Node + chromium headless pour le rendu des visuels.
FROM node:20-slim

# Chromium + polices (emoji/latin) pour le rendu headless.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-color-emoji ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY scripts ./scripts

# Donnees clients (tokens, brand, historiques) : volume persistant.
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "src/server.mjs"]
