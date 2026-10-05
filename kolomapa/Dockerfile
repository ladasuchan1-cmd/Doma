# Kolomapa jako kontejner pro server s Dockerem a Caddy (Hetzner, ksprehledy.cz) – postup: deploy/docker/HETZNER.md.
# Stejný vzor jako ostatní aplikace (r01sales, projekty, import-web): kontejner na síti „web“, ven ho pouští Caddy.
#   stavba  docker build -t kolomapa .     (volitelně --build-arg S_PROHLIZECEM=1 → Chromium pro Cyklobazar)
#   běh     docker run -d --name kolomapa --restart unless-stopped --network web \
#             --env-file /root/kolomapa.env -v /root/kolomapa-data:/app/data kolomapa
# Obojí dělá deploy/docker/nasadit.sh.
FROM node:22-bookworm-slim

# Pražský čas: plánovač stahuje v 05:30 místního času a přehledy ukazují místní čas. Samotné TZ nestačí – debian-slim
# nemá databázi časových pásem, proto tzdata (jako Sales a Radar). sqlite3 kvůli denní záloze databáze (nasadit.sh).
ENV TZ=Europe/Prague \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata ca-certificates sqlite3 \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo $TZ > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Závislosti zvlášť a před kódem, ať se vrstva recykluje mezi stavbami. Kolomapa žádný balíček nepotřebuje;
# volitelné: @anthropic-ai/sdk (AI nacenění, zapne ANTHROPIC_API_KEY) a playwright (Cyklobazar; zatím bez Chromia).
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock

# Chromium pro Cyklobazar jen na vyžádání (KOLOMAPA_PROHLIZEC=1 v /root/kolomapa.env → nasadit.sh předá build-arg):
# ~400 MB navíc a Cyklobazar je ve výchozím stavu stejně vypnutý (viz README, Zdroje).
ARG S_PROHLIZECEM=0
RUN if [ "$S_PROHLIZECEM" = "1" ]; then \
      npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*; \
    fi

# Kód (bez data/, dist/, nastaveni.txt, .env – viz .dockerignore). Běží pod uživatelem node (UID 1000), ne root.
COPY --chown=node:node . .
# data/ je bind mount z hostitele (databáze přežije přestavbu); zakládá se i tady, aby obraz běžel i bez něj (testy).
RUN mkdir -p /app/data && chown node:node /app /app/data
USER node

# Jen uvnitř sítě web (Caddy → kolomapa:8050); vše ostatní (heslo, zdroje, klíč k AI) přes --env-file.
# KOLOMAPA_TRUST_PROXY: adresa návštěvníka pro ochranu proti hádání hesla z X-Forwarded-For od Caddy.
ENV KOLOMAPA_HOST=0.0.0.0 \
    KOLOMAPA_PORT=8050 \
    KOLOMAPA_TRUST_PROXY=1
EXPOSE 8050
# Bez hesla 200, s heslem 401 – obojí znamená „server odpovídá“; 5xx nebo nic = nemocný.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8050/api/run').then((r) => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
