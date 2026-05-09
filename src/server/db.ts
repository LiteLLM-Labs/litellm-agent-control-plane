/**
 * HMR-safe Prisma singleton.
 *
 * In dev, Next.js hot-reloads modules, which would otherwise spin up a new
 * PrismaClient (and a new connection pool) on every reload. We stash the
 * instance on `globalThis` so the same client is reused across reloads.
 *
 * In production we just instantiate once per process.
 *
 * Canonical pattern:
 * https://www.prisma.io/docs/orm/more/help-and-troubleshooting/help-articles/nextjs-prisma-client-dev-practices
 */

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { __prisma__?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__prisma__ ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__prisma__ = prisma;
}
