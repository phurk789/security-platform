# 13STORE Public Security Twin — server image (also contains the edge gateway program).
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/gateway/package.json apps/gateway/
COPY apps/web/package.json apps/web/
COPY apps/field/package.json apps/field/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w @13store/web \
 && npm run build -w @13store/field \
 && npm run build -w @13store/server \
 && npm run build -w @13store/gateway

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
# Only the runtime dependencies the bundles leave external.
RUN npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund fastify@5 @fastify/websocket@11 @fastify/static@10 ws@8 \
 && mkdir -p /data && chown node:node /data
COPY --from=build /src/apps/server/dist apps/server/dist
COPY --from=build /src/apps/gateway/dist apps/gateway/dist
COPY --from=build /src/apps/web/dist apps/web/dist
COPY --from=build /src/apps/field/dist apps/field/dist
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
