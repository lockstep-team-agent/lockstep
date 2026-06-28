/**
 * The dashboard's own public base URL — used to build the GitHub OAuth redirect_uri, which must
 * match a callback registered on the GitHub App. Prefers an explicit LOCKSTEP_WEB_URL; otherwise
 * derives it from the proxy headers (Railway/most hosts set x-forwarded-*), then the request origin.
 */
export function baseUrl(request: Request): string {
  if (process.env.LOCKSTEP_WEB_URL) return process.env.LOCKSTEP_WEB_URL.replace(/\/+$/, "");
  const h = request.headers;
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host");
  return host ? `${proto}://${host}` : new URL(request.url).origin;
}
