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
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
