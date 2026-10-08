# Mapa prodejen a servisů kol – kontejner s webem a sdílenými daty týmu.
# Staví se ze složky mapa-prodejen:  docker build -t mapa-prodejen .
FROM node:22-alpine

# Český čas pro logy a data uložení (Node bere časové zóny z vlastní ICU databáze).
ENV TZ=Europe/Prague

# Verze aplikace – posílá ji deploy/server.sh (--build-arg APP_VERSION); zobrazuje se v /api/health.
ARG APP_VERSION=""
ENV APP_VERSION=$APP_VERSION

ENV NODE_ENV=production
ENV PORT=8094
# Stav spolupráce, objednávky, ručně přidaná místa a tajný klíč cookie žijí mimo image – ve svazku /data.
ENV MP_DATA=/data

WORKDIR /app
# Závislosti (Claude SDK pro asistenta mapy) zvlášť – při změně kódu se nestahují znovu.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY . .
RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME ["/data"]
EXPOSE 8094

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8094/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
