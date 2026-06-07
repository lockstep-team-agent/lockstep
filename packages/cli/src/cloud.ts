import { getToken } from "./auth/token-store.js";
import { resolveApiUrl } from "./config.js";

async function req<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const API = resolveApiUrl();
  const token = await getToken();
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(
      `Cannot reach the Lockstep API at ${API}\n` +
        `Set your server once with:  lockstep login --api <url>`,
    );
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text || res.statusText}`);
  }
  return json as T;
}

/** Thin authed HTTP client to the core API. Reads the server from config/env each call. */
export const cloud = {
  get apiUrl(): string {
    return resolveApiUrl();
  },
  get: <T = unknown>(p: string) => req<T>("GET", p),
  post: <T = unknown>(p: string, b?: unknown) => req<T>("POST", p, b),
  patch: <T = unknown>(p: string, b?: unknown) => req<T>("PATCH", p, b),
  del: <T = unknown>(p: string) => req<T>("DELETE", p),
};
