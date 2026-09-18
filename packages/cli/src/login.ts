import { cloud } from "./cloud.js";
import { getToken, setToken } from "./auth/token-store.js";

export async function ensureLoggedIn(): Promise<void> {
  if (await getToken()) {
    try {
      const me = await cloud.get<{ principal: { githubLogin: string } }>("/me");
      console.log(`Signed in as @${me.principal.githubLogin}`);
      return;
    } catch { /* An expired token needs the ordinary device flow. */ }
  }
  await runLogin({});
}

interface LoginResp {
  status?: string;
  token?: string;
  githubLogin?: string;
  error?: string;
}

export async function runLogin(opts: { dev?: { id: number; login: string } }): Promise<void> {
  if (opts.dev) {
    // A hosted server does not expose this route at all, so the raw "404 Route not found" that
    // surfaced here read like an outage rather than "this flag is for local self-hosts".
    const r = await cloud
      .post<LoginResp>("/auth/dev-login", {
        githubUserId: opts.dev.id,
        githubLogin: opts.dev.login,
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (/\b404\b/.test(msg)) {
          throw new Error(
            `${cloud.apiUrl} has no dev-login route.\n` +
              `--dev is a LOCAL self-host bypass and needs LOCKSTEP_DEV_LOGIN=1 on your own server.\n` +
              `To sign in to a hosted server, drop --dev:  lockstep login --api ${cloud.apiUrl}`,
          );
        }
        throw e;
      });
    if (!r.token) throw new Error("dev-login failed (is LOCKSTEP_DEV_LOGIN enabled on the server?)");
    await setToken(r.token);
    console.log(`logged in as ${r.githubLogin} (dev)`);
    return;
  }

  const start = await cloud.post<{
    verification_uri: string;
    user_code: string;
    device_code: string;
    interval?: number;
  }>("/auth/device/start");
  console.log(`\nOpen ${start.verification_uri} and enter code:  ${start.user_code}\n`);
  const interval = (start.interval ?? 5) * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, interval));
    const poll = await cloud.post<LoginResp>("/auth/device/poll", { device_code: start.device_code });
    if (poll.status === "ok" && poll.token) {
      await setToken(poll.token);
      console.log(`logged in as ${poll.githubLogin}`);
      return;
    }
    if (poll.error && poll.error !== "authorization_pending" && poll.error !== "slow_down") {
      console.error(`login failed: ${poll.error}`);
      process.exit(1);
    }
  }
}
