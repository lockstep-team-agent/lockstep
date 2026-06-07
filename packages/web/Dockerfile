# Built from the monorepo root context.
FROM node:20-alpine AS build
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build -w @lockstep/web

FROM node:20-alpine AS run
WORKDIR /app/packages/web
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/web /app/packages/web
# Railway injects PORT; Next listens on it (fallback 3000).
CMD ["sh", "-c", "npx next start -p ${PORT:-3000}"]
