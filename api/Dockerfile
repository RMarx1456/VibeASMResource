# syntax=docker/dockerfile:1
# Build context is the repository root (see docker-compose.yml) so that the
# parsed dataset (etl/data) and shared schema (db/init) can be copied in.

# ---- build stage ---------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY api/package.json api/package-lock.json* ./
RUN npm install
COPY api/tsconfig.json ./
COPY api/src ./src
RUN npm run build

# ---- runtime stage -------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY api/package.json api/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# Seed dataset and schema (read at startup).
COPY etl/data/instructions.json ./data/instructions.json
COPY db/init/01-schema.sql ./db/01-schema.sql
EXPOSE 4000
CMD ["node", "dist/index.js"]
