"use client";
import { useState } from "react";
import { feedbackAction } from "@/adoption-actions";
import { Button } from "@/components/ui/button";
export function CheckFeedback(props: { orgId: string; projectId: string; checkId: string; decisionId: string }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return <div className="flex flex-wrap items-center gap-2 mt-2">{[["useful", "Useful concern"], ["false_positive", "False positive"], ["intentional_exception", "Intentional exception"]].map(([value, label]) => <Button key={value} size="sm" variant="ghost" disabled={busy} onClick={async () => {
    setBusy(true); try { const result = await feedbackAction(props.orgId, props.projectId, props.checkId, props.decisionId, value!); setMessage(result.error || result.message || ""); } catch { setMessage("Could not save feedback."); } finally { setBusy(false); }
  }}>{label}</Button>)}<span role="status" className="text-xs">{message}</span></div>;
}
