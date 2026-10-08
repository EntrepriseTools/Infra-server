# Le plan de contrôle : Node + git + le CLI docker (le démon est celui de l'hôte, via le socket).
FROM docker:27-cli AS docker

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web

ENV NODE_ENV=production RAIL_DATA_DIR=/data
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RAIL_PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.js"]
