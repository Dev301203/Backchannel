# Backchannel realtime server.
# Build context must be the REPO ROOT (not server/) because the server imports
# the shared ../normalize.js.  See docker-compose.yml.
FROM node:22-alpine AS base
WORKDIR /app

# Install dependencies first for better layer caching.
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && (npm ci || npm install)

# App source + the shared normalizer (resolved as ../../normalize.js).
COPY server ./server
COPY normalize.js ./normalize.js

WORKDIR /app/server
ENV NODE_ENV=production
EXPOSE 8080

# tsx runs the TypeScript directly; no separate build step required.
CMD ["npm", "run", "start"]
