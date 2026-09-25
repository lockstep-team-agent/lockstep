"use client";
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { briefSummaryAction } from "@/next-actions";

/**
 * "Why this was raised" — generated once per decision version (server-cached). The brief never
 * waits for it: the factual line renders immediately and the summary replaces it when ready.
 */
export function BriefSummary({
  orgId,
  projectId,
  decisionId,
  initial,
  fallback,
}: {
  orgId: string;
  projectId: string;
  decisionId: string;
  initial: string | null;
  fallback: string;
}) {
  const [text, setText] = useState<string | null>(initial);
  const [state, setState] = useState<"idle" | "loading" | "none">(initial ? "idle" : "loading");
  useEffect(() => {
    if (initial) return;
    let live = true;
    briefSummaryAction(orgId, projectId, decisionId).then((s) => {
      if (!live) return;
      if (s?.text) {
        setText(s.text);
        setState("idle");
      } else setState("none");
    });
    return () => {
      live = false;
    };
  }, [orgId, projectId, decisionId, initial]);
  return (
    <div className="text-[13px] leading-5">
      {text ? (
        <>
          <p className="text-foreground">{text}</p>
          <p className="mt-1 flex items-center gap-1 text-[11px] text-faint">
            <Sparkles className="h-3 w-3" /> Generated from the sources below — check them before deciding.
          </p>
        </>
      ) : (
        <>
          <p className="text-muted-foreground">{fallback}</p>
          {state === "loading" && <p className="mt-1 text-[11px] text-faint">Writing a summary…</p>}
        </>
      )}
    </div>
  );
}
