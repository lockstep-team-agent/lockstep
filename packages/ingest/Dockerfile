# Built from the monorepo root context. The v2 ingest sweep worker: no HTTP server,
# it loops `sweep` on an interval and talks to core over LOCKSTEP_API_URL.
FROM node:20-alpine AS build
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build -w @lockstep/ingest

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/ingest ./packages/ingest
# Loop: fetch → distill → propose, every 15 min (serve default). Env: LOCKSTEP_API_URL,
# LOCKSTEP_INGEST_TOKEN, COMPOSIO_API_KEY, ANTHROPIC_API_KEY.
CMD ["node", "packages/ingest/dist/index.js", "serve"]
