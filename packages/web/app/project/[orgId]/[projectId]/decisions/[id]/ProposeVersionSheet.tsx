"use client";
import { useEffect, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Field } from "@/components/Field";
import { proposeVersionAction, type ProposeVersionState } from "@/actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Proposing…" : "Propose version"}
    </Button>
  );
}

export function ProposeVersionSheet(props: {
  orgId: string;
  projectId: string;
  id: string;
  scopeKind: string;
  scopeRef: string;
  decisionType: string;
  baseVersion: number;
  ruleText: string;
  rationale: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useFormState<ProposeVersionState | undefined, FormData>(proposeVersionAction, undefined);
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [state?.ok, router]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="secondary" size="sm">
          Propose new version
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Propose v{props.baseVersion + 1}</SheetTitle>
          <SheetDescription>
            The new version supersedes v{props.baseVersion} once it binds. Affected teams are notified by blast radius.
          </SheetDescription>
        </SheetHeader>
        <form action={formAction} className="mt-6 grid gap-4">
          <input type="hidden" name="orgId" value={props.orgId} />
          <input type="hidden" name="projectId" value={props.projectId} />
          <input type="hidden" name="id" value={props.id} />
          <input type="hidden" name="scopeKind" value={props.scopeKind} />
          <input type="hidden" name="scopeRef" value={props.scopeRef} />
          <input type="hidden" name="decisionType" value={props.decisionType} />
          <input type="hidden" name="baseVersion" value={props.baseVersion} />
          <Field label="Rule text" htmlFor="pv-rule" hint="One durable imperative sentence.">
            <Textarea id="pv-rule" name="ruleText" rows={3} defaultValue={props.ruleText} required />
          </Field>
          <Field label="Rationale" htmlFor="pv-rationale" hint="Why this changes.">
            <Textarea id="pv-rationale" name="rationale" rows={3} defaultValue={props.rationale ?? ""} />
          </Field>
          <Field label="Review on" htmlFor="pv-review" hint="Optional tripwire; the rule stays binding.">
            <Input id="pv-review" type="date" name="reviewAt" className="w-48" />
          </Field>
          {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Submit />
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
