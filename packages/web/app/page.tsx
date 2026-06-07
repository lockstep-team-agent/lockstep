import Link from "next/link";
import { hasToken, apiGet } from "./lib/api";
import { loginAction, logoutAction, createOrgAction, createProjectAction } from "./actions";

export const dynamic = "force-dynamic";

interface Me {
  principal: { githubLogin: string };
  memberships: Array<{ orgId: string }>;
}
interface OrgOverview {
  projects: Array<{ id: string; name: string }>;
  members: Array<{ id: string; githubLogin: string }>;
}

export default async function Home() {
  if (!hasToken()) {
    return (
      <main>
        <h1>Sign in</h1>
        <p className="muted">
          Paste a Lockstep session token (run <code>lockstep login</code> in your terminal). Web GitHub
          sign-in is the next iteration.
        </p>
        <form action={loginAction}>
          <input name="token" placeholder="lsk_..." style={{ width: 360 }} />
          <button type="submit">Sign in</button>
        </form>
      </main>
    );
  }

  const me = await apiGet<Me>("/me");
  if (!me) {
    return (
      <main>
        <p>Token invalid or API unreachable.</p>
        <form action={logoutAction}>
          <button type="submit">Sign out</button>
        </form>
      </main>
    );
  }

  const orgIds = [...new Set(me.memberships.map((m) => m.orgId))];
  const overviews = await Promise.all(orgIds.map(async (id) => ({ id, data: await apiGet<OrgOverview>(`/orgs/${id}/overview`) })));

  return (
    <main>
      <h1>
        {me.principal.githubLogin}'s workspace
        <form action={logoutAction} style={{ display: "inline-flex", marginLeft: 16 }}>
          <button type="submit">Sign out</button>
        </form>
      </h1>

      <form action={createOrgAction}>
        <input name="name" placeholder="New org name" />
        <button type="submit">Create org</button>
      </form>

      {orgIds.length === 0 && <p className="muted">No orgs yet — create one above.</p>}

      {overviews.map(({ id, data }) => (
        <div key={id} className="card">
          <h2>Org {id.slice(0, 8)}</h2>
          <p className="muted">Members: {(data?.members ?? []).map((m) => m.githubLogin).join(", ") || "—"}</p>
          <h2>Projects</h2>
          {(data?.projects ?? []).map((p) => (
            <div key={p.id} style={{ padding: "6px 0" }}>
              <Link href={`/project/${id}/${p.id}`}>{p.name}</Link>
            </div>
          ))}
          {(data?.projects ?? []).length === 0 && <p className="muted">No projects yet.</p>}
          <form action={createProjectAction}>
            <input type="hidden" name="orgId" value={id} />
            <input name="name" placeholder="New project name" />
            <button type="submit">Create project</button>
          </form>
        </div>
      ))}
    </main>
  );
}
