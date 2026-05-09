# syntax=docker/dockerfile:1.7

# ---------- 1. install ----------
FROM node:20-alpine AS deps
WORKDIR /app

# Only copy lockfiles first so `npm ci` is cached unless deps change.
COPY package.json package-lock.json ./
RUN npm ci

# ---------- 2. build ----------
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `npm ci` ran in the `deps` stage without prisma/schema.prisma in scope, so
# the Prisma client wasn't generated. Generate it here once the schema is
# present, before `next build` typechecks against `Prisma.*` types.
RUN npx prisma generate

# `output: "standalone"` in next.config.ts emits .next/standalone with a
# minimal node_modules — that's what the runtime stage runs.
RUN npm run build

# ---------- 3. run ----------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Tell Next.js it's behind /api/proxy on the same origin — no Pulumi gymnastics.
ENV NEXT_TELEMETRY_DISABLED=1

# Run as non-root.
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# server.js is what `output: "standalone"` writes — equivalent to `next start`
# but without dragging in the dev/test toolchain.
CMD ["node", "server.js"]

# ---------- 4. prisma migrate (compose init container) ----------
# `docker-compose.yml`'s db-migrate service builds this stage and runs it once
# at startup against the postgres service before web + worker come up.
FROM node:20-alpine AS prisma
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma
CMD ["npx", "prisma", "db", "push", "--accept-data-loss", "--skip-generate"]

# ---------- 5. worker (reconciler) ----------
# Reuses `builder` (full node_modules, full source) so `tsx` and the
# generated Prisma client are available at runtime.
FROM node:20-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json /app/package-lock.json /app/tsconfig.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src/server ./src/server
COPY --from=builder /app/src/worker ./src/worker
CMD ["npx", "tsx", "src/worker/index.ts"]
