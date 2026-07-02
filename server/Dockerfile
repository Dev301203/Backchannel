# Backchannel realtime server.
# Build context must be the REPO ROOT (not server/) because the server imports
# the shared ../normalize.js.  See docker-compose.yml.
FROM node:22-alpine AS base
WORKDIR /app

# Install dependencies first for better layer caching.
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && (npm ci || npm install)

# The shared /app/normalize.js is ESM and depends on `tldts`. Copying the repo
# root's package.json here (a) marks /app as "type": "module" so Node treats
# normalize.js as ESM, and (b) installs tldts into /app/node_modules so
# normalize.js can resolve it. --omit=dev skips the extension's build tooling.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# App source + the shared normalizer (resolved as ../../normalize.js) + the
# application schema (migrate.ts reads it as ../../../schema.sql).
COPY server ./server
COPY normalize.js ./normalize.js
COPY schema.sql ./schema.sql

WORKDIR /app/server
ENV NODE_ENV=production
EXPOSE 8080

# tsx runs the TypeScript directly; no separate build step required.
CMD ["npm", "run", "start"]
