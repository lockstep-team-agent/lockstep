import { ArrowRight, FolderGit2 } from "lucide-react";
import { hasToken, apiGet } from "@/lib/api";
import { loginAction, logoutAction } from "@/actions";
import type { Me, OrgOverview } from "@/lib/types";
import { Brand } from "@/components/shell/Brand";
import { ListRow } from "@/components/ListRow";
import { RefChip } from "@/components/RefChip";
import { Section } from "@/components/Section";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: { error?: string } }) {
  if (!hasToken()) {
    const errorText =
      searchParams?.error === "github_not_configured"
        ? "GitHub sign-in isn't configured on this server."
        : searchParams?.error
          ? "Sign-in failed. Please try again."
          : null;
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-sm shadow-none">
          <CardContent className="grid gap-5 p-6">
            <div className="flex justify-center">
              <Brand size="lg" />
            </div>
            <p className="text-center text-sm text-muted-foreground">
              The shared decision record your agents read before they act.
            </p>
            {errorText && (
              <p className="rounded-md border border-destructive-edge bg-destructive-soft p-2 text-center text-sm text-destructive">
                {errorText}
              </p>
            )}
            <Button asChild className="w-full">
              <a href="/login/github">Sign in with GitHub</a>
            </Button>
            <div className="flex items-center gap-3 text-2xs uppercase text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or paste a token
              <span className="h-px flex-1 bg-border" />
            </div>
            <form action={loginAction} className="grid gap-2">
              <Input
                name="token"
                placeholder="lsk_…"
                autoComplete="off"
                className="font-mono"
                aria-label="Session token"
              />
              <Button variant="secondary" type="submit" className="w-full">
                Sign in with token
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Get one with <RefChip copy={false}>lockstep login</RefChip>
              </p>
            </form>
          </CardContent>
        </Card>
      </main>
    );
  }

  const me = await apiGet<Me>("/me");
  if (!me) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-sm shadow-none">
          <CardContent className="grid gap-4 p-6 text-center">
            <p className="text-sm text-muted-foreground">Session expired or the API is unreachable.</p>
            <form action={logoutAction}>
              <Button variant="secondary" type="submit">
                Sign out
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    );
  }

  const orgIds = [...new Set(me.memberships.map((m) => m.orgId))];
  const orgs = await Promise.all(
    orgIds.map(async (id) => ({ id, data: await apiGet<OrgOverview>(`/orgs/${id}/overview`) })),
  );
  const active = orgs.flatMap(({ id, data }) =>
    (data?.projects ?? [])
      .filter((p) => !p.archived)
      .map((p) => ({ orgId: id, members: data?.members.length ?? 0, ...p })),
  );
  const archived = orgs.flatMap(({ id, data }) =>
    (data?.projects ?? []).filter((p) => p.archived).map((p) => ({ orgId: id, ...p })),
  );

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12">
      <div className="mb-8 flex items-center justify-between">
        <Brand size="lg" />
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          @{me.principal.githubLogin}
          <form action={logoutAction}>
            <Button variant="ghost" size="sm" type="submit">
              Sign out
            </Button>
          </form>
        </div>
      </div>

      {active.length === 0 ? (
        <EmptyState icon={<FolderGit2 />} title="No workspace yet">
          Run <RefChip copy={false}>lockstep connect</RefChip> inside a repo to create your workspace and link it.
        </EmptyState>
      ) : (
        <Section label="Projects" count={active.length}>
          {active.map((p) => (
            <ListRow
              key={p.id}
              href={`/project/${p.orgId}/${p.id}`}
              leading={
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary-soft text-xs font-semibold text-primary">
                  {(p.name[0] ?? "?").toUpperCase()}
                </span>
              }
              title={p.name}
              meta={
                <span>
                  {p.members} member{p.members === 1 ? "" : "s"}
                </span>
              }
              action={<ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden />}
            />
          ))}
        </Section>
      )}

      {archived.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Archived projects ({archived.length})
          </summary>
          <div className="mt-3">
            <Section label="Archived" count={archived.length}>
              {archived.map((p) => (
                <ListRow
                  key={p.id}
                  href={`/project/${p.orgId}/${p.id}/members`}
                  className="opacity-70"
                  title={p.name}
                  meta={<span>archived — open to unarchive</span>}
                  action={<ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden />}
                />
              ))}
            </Section>
          </div>
        </details>
      )}
    </main>
  );
}
