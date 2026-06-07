import type { FastifyRequest } from "fastify";
import { validateToken, type Principal } from "../auth/tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/** onRequest hook: if a valid bearer token is present, attach the principal. */
export async function authHook(req: FastifyRequest): Promise<void> {
  const h = req.headers.authorization;
  if (h && h.startsWith("Bearer ")) {
    const p = await validateToken(h.slice(7));
    if (p) req.principal = p;
  }
}
