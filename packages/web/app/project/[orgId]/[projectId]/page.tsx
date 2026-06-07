import Link from "next/link";
import { apiGet } from "../../../lib/api";
import { connectRepoAction, inviteAction } from "../../../actions";

export const dynamic = "force-dynamic";

interface Overview {
  decisions: Array<{ id: string; scopeKind: string; scopeRef: string; status: string; version: number; ruleText: string }>;
  questions: Array<{ id: string; body: string; status: string; scopeRef: string | null; urgent: boolean }>;
  tasks: Array<{ id: string; title: string; runState: string; status: string }>;
  repos: Array<{ id: string; gitRemote: string }>;
  audit: Array<{ action: string; entityKind: string | null; createdAt: string }>;
}

export default async function ProjectPage({ params }: { params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const o = await apiGet<Overview>(`/orgs/${orgId}/projects/${projectId}/overview`);
  if (!o) {
    return (
      <main>
        <p>Not found or not authorized.</p>
        <Link href="/">← back</Link>
      </main>
    );
  }

  return (
    <main>
      <p>
        <Link href="/">← workspace</Link>
      </p>
      <h1>Project {projectId.slice(0, 8)}</h1>

      <h2>Decisions</h2>
      <table>
        <thead>
          <tr>
            <th>Scope</th>
            <th>Rule</th>
            <th>Status</th>
            <th>v</th>
          </tr>
        </thead>
        <tbody>
          {o.decisions.map((d) => (
            <tr key={d.id}>
              <td>{d.scopeRef}</td>
              <td>{d.ruleText}</td>
              <td>
                <span className={`pill ${d.status}`}>{d.status}</span>
              </td>
              <td>{d.version}</td>
            </tr>
          ))}
          {o.decisions.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                none
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Questions</h2>
      <table>
        <thead>
          <tr>
            <th>Question</th>
            <th>Scope</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {o.questions.map((q) => (
            <tr key={q.id}>
              <td>
                {q.urgent ? "⚡ " : ""}
                {q.body}
              </td>
              <td>{q.scopeRef ?? "—"}</td>
              <td>
                <span className={`pill ${q.status}`}>{q.status}</span>
              </td>
            </tr>
          ))}
          {o.questions.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                none
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Tasks</h2>
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Run state</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {o.tasks.map((t) => (
            <tr key={t.id}>
              <td>{t.title}</td>
              <td>{t.runState}</td>
              <td>
                <span className={`pill ${t.status}`}>{t.status}</span>
              </td>
            </tr>
          ))}
          {o.tasks.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                none
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Repos</h2>
      {o.repos.map((r) => (
        <div key={r.id} className="muted">
          {r.gitRemote}
        </div>
      ))}
      <form action={connectRepoAction}>
        <input type="hidden" name="orgId" value={orgId} />
        <input type="hidden" name="projectId" value={projectId} />
        <input name="gitRemote" placeholder="github.com/org/repo" style={{ width: 280 }} />
        <button type="submit">Connect repo</button>
      </form>

      <h2>Invite a teammate</h2>
      <form action={inviteAction}>
        <input type="hidden" name="orgId" value={orgId} />
        <input type="hidden" name="projectId" value={projectId} />
        <input name="githubLogin" placeholder="github-handle" />
        <button type="submit">Invite</button>
      </form>

      <h2>Audit trail</h2>
      <table>
        <thead>
          <tr>
            <th>Action</th>
            <th>Entity</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {o.audit.map((a, i) => (
            <tr key={i}>
              <td>{a.action}</td>
              <td>{a.entityKind ?? "—"}</td>
              <td className="muted">{new Date(a.createdAt).toLocaleString()}</td>
            </tr>
          ))}
          {o.audit.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                none
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
