"use client";

import { useState } from "react";

export interface Source {
  id: string;
  name: string;
}

/**
 * Searchable picker for a Slack channel / Notion database inside the allowlist form. Renders the two
 * form fields the server action reads — `sourceRef` (the id) and `sourceName` (the label). You can
 * type to filter by name or id and click a result; if no sources are available (or you type an id the
 * list doesn't contain) it degrades to raw-id entry, so the field always works.
 */
export function SourcePicker({ sources, hint }: { sources: Source[]; hint: string }) {
  const [ref, setRef] = useState("");
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);

  const q = ref.toLowerCase();
  const matches = sources.filter((s) => `${s.name} ${s.id}`.toLowerCase().includes(q)).slice(0, 12);

  return (
    <div style={{ position: "relative", flex: 1, minWidth: 240 }}>
      <input
        name="sourceRef"
        className="input"
        style={{ width: "100%" }}
        placeholder={sources.length ? "search by name…" : hint}
        value={ref}
        autoComplete="off"
        required
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
        <div
          className="card"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 20,
            marginTop: 4,
            maxHeight: 240,
            overflowY: "auto",
            padding: 4,
          }}
        >
          {matches.map((s) => (
            <button
              type="button"
              key={s.id}
              className="row"
              style={{
                width: "100%",
                textAlign: "left",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "6px 8px",
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                setRef(s.id);
                setName(s.name);
                setOpen(false);
              }}
            >
              <div className="body">
                <div className="title">{s.name}</div>
                <div className="meta">
                  <span className="code-ref">{s.id}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
