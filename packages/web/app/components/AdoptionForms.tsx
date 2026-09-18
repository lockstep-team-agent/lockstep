"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { createPilotAction, saveBriefAction, type AdoptionState } from "@/adoption-actions";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

function Submit({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return <Button type="submit" disabled={pending}>{pending ? "Saving…" : children}</Button>;
}
function Result({ state }: { state: AdoptionState }) {
  return <div aria-live="polite">{state.error && <p className="text-sm text-destructive">{state.error}</p>}{state.message && <p className="text-sm">{state.message} {state.href && <Link className="underline" href={state.href}>Open brief →</Link>}</p>}</div>;
}
export function CreatePilotForm() {
  const [state, action] = useFormState(createPilotAction, {});
  return <form action={action} className="grid gap-3 rounded-lg border p-4 mb-6">
    <h2 className="font-semibold">Start with one product brief</h2>
    <p className="text-sm text-muted-foreground">Review requirements and copy an implementation brief. No repo or developer setup needed.</p>
    <label className="grid gap-1 text-sm">Project name<Input name="name" required maxLength={120} placeholder="e.g. Customer onboarding" /></label>
    <div><Submit>Create project</Submit></div><Result state={state} />
  </form>;
}
export interface NativeVersion { version: number; title: string; content: string; featureRef: string; createdAt: string }
export function NativeBriefForm({ orgId, projectId, documentId, version }: { orgId: string; projectId: string; documentId?: string; version?: NativeVersion }) {
  const [state, action] = useFormState(saveBriefAction, {});
  if (!documentId && state.href) return <div className="rounded-lg border p-4 mb-6"><Result state={state} /></div>;
  return <form action={action} className="grid gap-3 rounded-lg border p-4 mb-6">
    <h2 className="font-semibold">{version ? `Revise brief · version ${version.version}` : "Paste a product brief"}</h2>
    <p className="text-sm text-muted-foreground">Manually maintained. Save a source version, inspect proposed requirements, activate the source, then ratify in Review. Changed requirements return to review.</p>
    <input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="projectId" value={projectId} />
    {documentId && <input type="hidden" name="documentId" value={documentId} />}{version && <input type="hidden" name="baseVersion" value={version.version} />}
    <label className="grid gap-1 text-sm">Title<Input name="title" required maxLength={200} defaultValue={version?.title} /></label>
    <label className="grid gap-1 text-sm">Feature reference<Input name="featureRef" placeholder="feature:customer-onboarding" defaultValue={version?.featureRef} readOnly={!!version} pattern="feature:[a-z0-9][a-z0-9-]*" /></label>
    <label className="grid gap-1 text-sm">Source brief<Textarea name="content" required rows={12} defaultValue={version?.content} maxLength={200000} /></label>
    <details><summary className="cursor-pointer text-sm">Select requirements manually (optional)</summary><label className="grid gap-2 text-sm mt-2">Paste exact passages from this brief, separated by blank lines. These become draft requirements for review.<Textarea name="manualRules" rows={5} /></label></details>
    <div><Submit>{version ? "Save revision and review" : "Save and extract requirements"}</Submit></div><Result state={state} />
  </form>;
}
