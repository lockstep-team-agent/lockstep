import { cloud } from "./cloud.js";
import { setToken } from "./auth/token-store.js";

interface LoginResp {
  status?: string;
  token?: string;
  githubLogin?: string;
  error?: string;
}

export async function runLogin(opts: { dev?: { id: number; login: string } }): Promise<void> {
  if (opts.dev) {
    const r = await cloud.post<LoginResp>("/auth/dev-login", {
      githubUserId: opts.dev.id,
      githubLogin: opts.dev.login,
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
