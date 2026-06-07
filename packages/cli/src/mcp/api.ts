import { getToken } from "../auth/token-store.js";
import { resolveApiUrl } from "../config.js";

/** Session-aware authed request: attaches the bearer token and the x-lockstep-session header. */
export async function call<T = unknown>(
  method: string,
  path: string,
  sessionId: string | undefined,
  body?: unknown,
): Promise<T> {
  const API = resolveApiUrl();
  const token = await getToken();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { "x-lockstep-session": sessionId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text || res.statusText}`);
  return json as T;
}
