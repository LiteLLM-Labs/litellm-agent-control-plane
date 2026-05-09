/**
 * Single shared helper for managed-agents route handlers.
 *
 * Every handler does the same try/catch dance: a `Response` thrown from
 * `assertAuth` is forwarded as-is, an `HttpError` becomes its declared
 * `{status, detail}`, a `ZodError` becomes a 400 with the parse issues, and
 * anything else is logged + collapsed to a 500. Centralised here so each
 * handler stays focused on the actual work and we don't drift between files.
 */

import { ZodError } from "zod";
import { HttpError } from "@/server/types";

type Handler<Ctx> = (req: Request, ctx: Ctx) => Promise<Response> | Response;

export function wrap<Ctx = unknown>(handler: Handler<Ctx>): Handler<Ctx> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (e) {
      if (e instanceof Response) return e;
      if (e instanceof HttpError) {
        return Response.json({ error: e.detail }, { status: e.status });
      }
      if (e instanceof ZodError) {
        return Response.json({ error: e.issues }, { status: 400 });
      }
      console.error(e);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  };
}
