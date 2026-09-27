# Cenotvorba – repricingový nástroj. Bez npm závislostí, stačí Node.js 22.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY tools ./tools
ENV NODE_ENV=production \
    PORT=8080 \
    CENOTVORBA_DB=/data/cenotvorba.db
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8080
USER node
# Import / přecenění blokují server na jednotky až desítky sekund (běží synchronně) – proto velkorysý timeout.
HEALTHCHECK --interval=30s --timeout=30s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
