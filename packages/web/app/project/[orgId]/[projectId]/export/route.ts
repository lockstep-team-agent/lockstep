import { cookies } from "next/headers";

const API = (process.env.LOCKSTEP_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");

/** Audit export download: proxies core's CSV with the session cookie (the browser can't call core directly). */
export async function GET(_req: Request, { params }: { params: { orgId: string; projectId: string } }) {
  const t = cookies().get("lockstep_token")?.value;
  if (!t) return new Response("Sign in first", { status: 401 });
  const res = await fetch(`${API}/orgs/${params.orgId}/projects/${params.projectId}/audit-export?format=csv`, {
    headers: { authorization: `Bearer ${t}` },
    cache: "no-store",
  });
  if (!res.ok) return new Response("Export failed", { status: res.status });
  return new Response(res.body, {
    headers: {
      "content-type": res.headers.get("content-type") ?? "text/csv; charset=utf-8",
      "content-disposition": res.headers.get("content-disposition") ?? 'attachment; filename="lockstep-audit.csv"',
    },
  });
}
