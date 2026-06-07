import { cookies } from "next/headers";

const API = (process.env.LOCKSTEP_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");

function token(): string | undefined {
  return cookies().get("lockstep_token")?.value;
}

export function hasToken(): boolean {
  return !!token();
}

export async function apiGet<T = unknown>(path: string): Promise<T | null> {
  const t = token();
  const res = await fetch(`${API}${path}`, {
    headers: t ? { authorization: `Bearer ${t}` } : {},
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export async function apiPost<T = unknown>(path: string, body: unknown): Promise<T | null> {
  const t = token();
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}
