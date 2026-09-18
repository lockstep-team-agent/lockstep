"use client";
import { Button } from "@/components/ui/button";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="rounded-lg border border-destructive-edge bg-destructive-soft p-6">
      <h2 className="text-base font-medium">Couldn&apos;t load this page</h2>
      <p className="mt-1 text-sm text-muted-foreground">{error.message || "The API returned an error."}</p>
      <Button variant="secondary" size="sm" className="mt-4" onClick={reset}>
        Retry
      </Button>
    </div>
  );
}
