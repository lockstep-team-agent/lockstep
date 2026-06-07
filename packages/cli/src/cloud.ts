import { getToken } from "./auth/token-store.js";

const API = process.env.LOCKSTEP_API_URL ?? "http://localhost:8080";

async function req<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text || res.statusText}`);
  }
  return json as T;
}

/** Thin authed HTTP client to the core API. Every edge component talks through this. */
export const cloud = {
  apiUrl: API,
  get: <T = unknown>(p: string) => req<T>("GET", p),
  post: <T = unknown>(p: string, b?: unknown) => req<T>("POST", p, b),
  patch: <T = unknown>(p: string, b?: unknown) => req<T>("PATCH", p, b),
  del: <T = unknown>(p: string) => req<T>("DELETE", p),
};
