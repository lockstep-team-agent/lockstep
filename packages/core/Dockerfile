# Build the core from the monorepo root context.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
RUN npm install --workspaces --include-workspace-root || npm install
COPY packages/core packages/core
RUN npm run build -w @lockstep/core

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/drizzle ./packages/core/drizzle
COPY --from=build /app/packages/core/sql ./packages/core/sql
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
# Run migrations then boot (self-host friendly: migrations apply on start).
CMD ["sh", "-c", "node packages/core/dist/db/migrate.js && node packages/core/dist/server.js"]
