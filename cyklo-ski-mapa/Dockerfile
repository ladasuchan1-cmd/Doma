# Cyklo & Ski mapa – kontejner s webem a sdíleným stavem oslovení.
# Staví se z kořene složky cyklo-ski-mapa:  docker build -t cyklo-ski-mapa .
FROM node:22-alpine

# Český čas pro logy a data uložení. Node bere časové zóny z vlastní ICU databáze, takže systémová
# tzdata není potřeba (a build nepotřebuje síť mimo stažení základního image).
ENV TZ=Europe/Prague

# Verze aplikace – posílá ji deploy.sh z gitu (--build-arg APP_VERSION); zobrazuje se v /api/health.
ARG APP_VERSION=""
ENV APP_VERSION=$APP_VERSION

ENV NODE_ENV=production
ENV PORT=8090
# Stav oslovení a tajný klíč cookie žijí mimo image – ve svazku /data.
ENV CSM_STAV=/data/stav.json

WORKDIR /app
COPY . .
RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME ["/data"]
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8090/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
