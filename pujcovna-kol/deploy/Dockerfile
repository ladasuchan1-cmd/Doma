# Půjčovna kol – kontejner s aplikací (SPEC kap. 15). Node 22 (vestavěný node:sqlite), 0 npm závislostí → žádný npm install.
# Staví se z kořene složky pujcovna-kol (kontext ..), Dockerfile leží v deploy/:
#   docker build -f deploy/Dockerfile -t pujcovna-kol .
# docker-compose.yml to dělá sám (build.context: .., build.dockerfile: deploy/Dockerfile).
FROM node:22-alpine

# Český čas pro logy; Node má vlastní ICU databázi časových zón, systémová tzdata není potřeba.
ENV TZ=Europe/Prague

# Verze aplikace – hetzner.sh ji posílá z gitu (--build-arg APP_VERSION); zobrazuje se v /api/health a patičce
# a slouží jako ?v= u statických souborů.
ARG APP_VERSION=""
ENV APP_VERSION=$APP_VERSION

ENV NODE_ENV=production \
    PORT=8092 \
    PK_DATA=/data \
    PK_TENANTS=/app/tenants

WORKDIR /app

# Jen to, co server potřebuje za běhu (bez test/, docs/, data/, cache/). Pořadí od nejméně měněného kvůli cache vrstev.
COPY package.json server.js ./
COPY legal ./legal
COPY tenants ./tenants
COPY public ./public
COPY tools ./tools
COPY src ./src
COPY deploy/docker-entrypoint.sh ./deploy/docker-entrypoint.sh

# Data (DB per tenant, .secret) žijí mimo image ve svazku /data; aplikace běží pod uživatelem node,
# kód v /app zůstává ve vlastnictví roota (jen ke čtení).
RUN mkdir -p /data && chown node:node /data && chmod 755 /app/deploy/docker-entrypoint.sh
USER node
VOLUME ["/data"]
EXPOSE 8092

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

# Entrypoint v demo režimu (PK_DEMO=1, výchozí) nejdřív idempotentně naplní demo data (tools/demo-data.js),
# pak spustí server stejně jako `npm start`: node --disable-warning=ExperimentalWarning server.js
ENTRYPOINT ["/app/deploy/docker-entrypoint.sh"]
