import { NextResponse } from "next/server";
import { baseUrl } from "@/lib/baseUrl";

const GH_AUTHORIZE = "https://github.com/login/oauth/authorize";

/** Start "Sign in with GitHub": redirect to GitHub's authorize page with a CSRF state cookie. */
export async function GET(request: Request): Promise<Response> {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const home = new URL("/", baseUrl(request));
  if (!clientId) {
    home.searchParams.set("error", "github_not_configured");
    return NextResponse.redirect(home);
  }
  const state = crypto.randomUUID();
  const redirectUri = new URL("/login/github/callback", baseUrl(request)).toString();
  const authorize = new URL(GH_AUTHORIZE);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", state);

  const res = NextResponse.redirect(authorize.toString());
  res.cookies.set("ls_oauth_state", state, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
  return res;
}
