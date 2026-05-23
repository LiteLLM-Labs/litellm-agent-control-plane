# Build context must be repo root: docker build -f cloud-vault/Dockerfile .
FROM node:20-alpine

WORKDIR /app

# Copy prisma schema (needed for prisma generate)
COPY prisma/ ./prisma/

# Copy cloud-vault package files
COPY cloud-vault/package.json cloud-vault/package-lock.json* ./
RUN npm install --production=false

COPY cloud-vault/tsconfig.json ./
COPY cloud-vault/src/ ./src/

RUN npx prisma generate --schema=./prisma/schema.prisma
RUN npx tsc

EXPOSE 14322
CMD ["node", "dist/server.js"]
