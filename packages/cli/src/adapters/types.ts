export type Scope = "project" | "user";

/**
 * The vendor seam. Core/MCP tools are identical across vendors; only config writing
 * and event-name mapping differ. Adding Codex/Gemini = a new implementation, zero core change.
 */
export interface VendorAdapter {
  id: string;
  detect(): Promise<boolean>;
  install(cwd: string, scope: Scope, dryRun: boolean): Promise<string[]>;
  verify(cwd: string, scope: Scope): Promise<{ ok: boolean; details: string[] }>;
}
