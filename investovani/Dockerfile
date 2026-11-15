# Investiční škola – kontejner se stránkou průvodce, přihlášením a deníkem obchodů.
# Staví se ze složky investovani:  docker build -t investovani .
FROM node:22-alpine

ENV TZ=Europe/Prague
ARG APP_VERSION=""
ENV APP_VERSION=$APP_VERSION
ENV NODE_ENV=production
ENV PORT=8095
# Deník a klíč cookie žijí mimo image, ve svazku /data.
ENV INV_DATA=/data

WORKDIR /app
COPY server.js trh.js zdroje.js index.html ./
RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME ["/data"]
EXPOSE 8095

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8095/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
