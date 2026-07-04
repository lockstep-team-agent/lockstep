import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

/** Shared Anthropic client (reads ANTHROPIC_API_KEY from env). */
export function anthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required for distillation");
    client = new Anthropic();
  }
  return client;
}

export const MODELS = {
  recall: "claude-haiku-4-5",
  extract: "claude-sonnet-4-6",
  recheck: "claude-opus-4-8",
} as const;
