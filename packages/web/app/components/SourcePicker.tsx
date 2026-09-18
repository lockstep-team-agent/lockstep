"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";

export interface Source {
  id: string;
  name: string;
}

/**
 * Searchable picker for a Slack channel / Notion database inside the allowlist form. Renders the two
 * form fields the server action reads — `sourceRef` (the id) and `sourceName` (the label). Type to
 * filter by name or id and pick a result; with no sources (or an unknown id) it degrades to raw-id entry.
 */
export function SourcePicker({ sources, hint }: { sources: Source[]; hint: string }) {
  const [ref, setRef] = useState("");
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);

  const q = ref.toLowerCase();
  const matches = sources.filter((s) => `${s.name} ${s.id}`.toLowerCase().includes(q)).slice(0, 12);

  return (
    <div className="relative min-w-60 flex-1">
      <Input
        name="sourceRef"
        placeholder={sources.length ? "Search by name…" : hint}
        value={ref}
        autoComplete="off"
        required
        aria-label="Source"
        onChange={(e) => {
          setRef(e.target.value);
          setName("");
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      <input type="hidden" name="sourceName" value={name} />
      {open && matches.length > 0 && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {matches.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                role="option"
                aria-selected={ref === s.id}
                className="flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left hover:bg-muted"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setRef(s.id);
                  setName(s.name);
                  setOpen(false);
                }}
              >
                <span className="text-sm">{s.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{s.id}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
