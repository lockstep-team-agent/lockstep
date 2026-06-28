import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { baseUrl } from "@/lib/baseUrl";

const API = (process.env.LOCKSTEP_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");

/** GitHub redirects back here with ?code&state. Verify state, swap the code for a session token
 *  (core holds the client secret), set the httpOnly cookie, and land the user signed in. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = cookies().get("ls_oauth_state")?.value;
  const home = new URL("/", baseUrl(request));

  if (!code || !state || !expected || state !== expected) {
    home.searchParams.set("error", "oauth_state");
    return NextResponse.redirect(home);
  }

  const redirectUri = new URL("/login/github/callback", baseUrl(request)).toString();
  let token: string | undefined;
  try {
    const res = await fetch(`${API}/auth/web/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, redirectUri }),
      cache: "no-store",
    });
    if (res.ok) token = ((await res.json()) as { token?: string }).token;
  } catch {
    /* fall through to error redirect */
  }

  if (!token) {
    home.searchParams.set("error", "signin_failed");
    return NextResponse.redirect(home);
  }

  const out = NextResponse.redirect(home);
  out.cookies.set("lockstep_token", token, { httpOnly: true, sameSite: "lax", path: "/" });
  out.cookies.delete("ls_oauth_state");
  return out;
}
