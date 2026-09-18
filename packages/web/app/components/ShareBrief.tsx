"use client";

import { useState } from "react";
import { previewBrief, recordExport, type Brief } from "@/adoption-actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function ShareBrief({ orgId, projectId, filters = {}, implementation = false }: { orgId: string; projectId: string; filters?: Record<string, string>; implementation?: boolean }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return <div className="grid gap-3 mb-6">
    <div><Button variant="secondary" disabled={busy} onClick={async () => {
      setBusy(true); setMessage("");
      try { const result = await previewBrief(orgId, projectId, filters); setBrief(result); if (!result) setMessage("Brief unavailable. Check your access and try again."); }
      catch { setMessage("Brief unavailable. Try again."); } finally { setBusy(false); }
    }}>{busy ? "Preparing…" : `Preview ${implementation ? "implementation" : "decision"} brief`}</Button></div>
    {brief && <div className="grid gap-3 rounded-lg border p-4">
      <p className="text-sm text-muted-foreground">{brief.accepted} accepted · {brief.proposed} drafts. Review before sharing. Copying grants no access.</p>
      <Textarea aria-label="Brief preview" value={brief.markdown} readOnly rows={15} className="font-mono text-xs" />
      <div><Button onClick={async () => {
        try { await navigator.clipboard.writeText(brief.markdown); setMessage("Copied to clipboard."); }
        catch { setMessage("Clipboard unavailable. Select and copy the preview text."); return; }
        try { await recordExport(orgId, projectId, brief.hash, filters); } catch { setMessage("Copied. Usage receipt could not be recorded; refresh the preview if the ledger changed."); }
      }}>Copy {implementation ? "implementation" : "decision"} brief</Button></div>
    </div>}
    <p role="status" className="text-sm">{message}</p>
  </div>;
}
