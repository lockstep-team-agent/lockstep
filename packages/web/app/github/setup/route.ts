import { NextResponse } from "next/server";
import { baseUrl } from "@/lib/baseUrl";
import { apiPost } from "@/lib/api";

/**
 * GitHub App "Setup URL" target. After the user installs the Lockstep app on their org, GitHub
 * redirects here with `?installation_id=…&state=<orgId>:<projectId>`. We record the installation on
 * core (which verifies the id via the App JWT) and land the user back on the project's Members page.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const installationId = url.searchParams.get("installation_id");
  const [orgId, projectId] = (url.searchParams.get("state") ?? "").split(":");

  if (installationId && orgId) {
    await apiPost(`/orgs/${orgId}/github/install`, { installationId: Number(installationId) });
  }
  const dest = orgId && projectId ? `/project/${orgId}/${projectId}/members?installed=1` : "/";
  return NextResponse.redirect(new URL(dest, baseUrl(request)));
}
