# Build the Next.js dashboard from the monorepo root context.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/web/package.json packages/web/package.json
RUN npm install --workspaces --include-workspace-root || npm install
COPY packages/web packages/web
RUN npm run build -w @lockstep/web

FROM node:20-alpine AS run
WORKDIR /app/packages/web
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/web /app/packages/web
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
