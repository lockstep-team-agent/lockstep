# Built from the monorepo root context. Migrations apply on boot (self-host + Railway friendly).
FROM node:20-alpine AS build
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build -w @lockstep/core

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core ./packages/core
# Railway injects PORT; the server reads env.PORT. Run migrations, then boot.
CMD ["sh", "-c", "node packages/core/dist/db/migrate.js && node packages/core/dist/server.js"]
