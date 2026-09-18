export interface HookInput { session_id?: string; cwd?: string; stop_hook_active?: boolean }

/** Read the bounded hook envelope, never the transcript or conversation. */
export async function readHookInput(): Promise<HookInput> {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    let body = "";
    const done = () => {
      clearTimeout(timer);
      process.stdin.off("data", data); process.stdin.off("end", done); process.stdin.off("error", done);
      process.stdin.pause();
      try {
        const parsed = JSON.parse(body) as HookInput;
        resolve({ session_id: typeof parsed.session_id === "string" && parsed.session_id.length <= 200 ? parsed.session_id : undefined, stop_hook_active: parsed.stop_hook_active === true });
      } catch { resolve({}); }
    };
    const data = (chunk: Buffer | string) => { body += String(chunk); if (body.length > 65536) { body = ""; done(); } };
    const timer = setTimeout(done, 300);
    process.stdin.on("data", data); process.stdin.once("end", done); process.stdin.once("error", done);
    process.stdin.resume();
  });
}
