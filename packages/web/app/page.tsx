import Link from "next/link";
import { hasToken, apiGet } from "@/lib/api";
import { loginAction, logoutAction } from "@/actions";
import type { Me, OrgOverview } from "@/lib/types";
import { IconArrow, IconRepo } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!hasToken()) {
    return (
      <div className="center-screen">
        <div className="auth-card card pad animate-in">
          <div className="brand">
            <span className="logo" /> Lockstep
          </div>
          <p style={{ color: "var(--muted)", fontSize: 13.5, textAlign: "center", margin: "0 0 18px" }}>
            Paste your session token to sign in.
            <br />
            Get one with <span className="code-ref">lockstep login</span> in your terminal.
          </p>
          <form action={loginAction} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input className="input mono" name="token" placeholder="lsk_…" autoComplete="off" />
            <button className="btn primary" type="submit" style={{ justifyContent: "center" }}>
              Sign in
            </button>
          </form>
        </div>
      </div>
    );
  }

  const me = await apiGet<Me>("/me");
  if (!me) {
    return (
      <div className="center-screen">
        <div className="auth-card card pad animate-in">
          <p style={{ color: "var(--muted)", marginBottom: 14 }}>Session expired or API unreachable.</p>
          <form action={logoutAction}>
            <button className="btn" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </div>
    );
  }

  const orgIds = [...new Set(me.memberships.map((m) => m.orgId))];
  const orgs = await Promise.all(
    orgIds.map(async (id) => ({ id, data: await apiGet<OrgOverview>(`/orgs/${id}/overview`) })),
  );

  return (
    <div className="center-screen" style={{ alignItems: "flex-start", paddingTop: 64 }}>
      <div style={{ width: "100%", maxWidth: 720 }}>
        <div className="brand animate-in" style={{ marginBottom: 26 }}>
          <span className="logo" /> Lockstep
          <div className="spacer" style={{ flex: 1 }} />
          <form action={logoutAction}>
            <button className="btn ghost" type="submit">
              Sign out
            </button>
          </form>
        </div>

        {orgIds.length === 0 && (
          <div className="empty animate-in">
            <div className="ico">
              <IconRepo />
            </div>
            <h3>No workspace yet</h3>
            <p>
              Run <span className="code-ref">lockstep connect</span> inside a repo to create your workspace and link it.
            </p>
          </div>
        )}

        <div className="stagger" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {orgs.flatMap(({ id, data }) =>
            (data?.projects ?? []).map((p) => (
              <Link
                key={p.id}
                href={`/project/${id}/${p.id}`}
                className="card pad"
                style={{ display: "flex", alignItems: "center", gap: 14 }}
              >
                <span className="avatar" style={{ borderRadius: 9 }}>
                  {(p.name[0] ?? "?").toUpperCase()}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 650 }}>{p.name}</div>
                  <div style={{ color: "var(--dim)", fontSize: 12.5 }}>{(data?.members ?? []).length} member(s)</div>
                </div>
                <IconArrow style={{ width: 18, height: 18, color: "var(--dim)" }} />
              </Link>
            )),
          )}
        </div>
      </div>
    </div>
  );
}
