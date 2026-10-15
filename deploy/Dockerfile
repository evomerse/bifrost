# Serveur relais Bifrost seul (sans Electron ni agent Windows).
# Contexte de build attendu : un dossier contenant server/, shared/, viewer/,
# package.json et package-lock.json (voir deploy/docker-compose.yml).
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY shared ./shared
COPY viewer ./viewer

# /data : annuaire des identifiants (ids.json). L'utilisateur "node" (uid 1000) doit pouvoir y ecrire.
RUN mkdir -p /data && chown node:node /data

ENV HOST=0.0.0.0 \
    PORT=7780 \
    DATA_DIR=/data \
    NODE_ENV=production

USER node
EXPOSE 7780

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:7780/ || exit 1

CMD ["node", "server/index.js"]
