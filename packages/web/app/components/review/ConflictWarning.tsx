import type { ReactNode } from "react";

/** Red warning paragraph — copy is composed by the caller so each surface keeps its exact wording. */
export function ConflictWarning({ children }: { children: ReactNode }) {
  return <p style={{ margin: "8px 0 0", color: "var(--red, #e5484d)" }}>⚠ {children}</p>;
}
