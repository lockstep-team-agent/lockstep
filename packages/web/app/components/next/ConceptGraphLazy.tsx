"use client";
import dynamic from "next/dynamic";

// React Flow + elkjs are ~500 kB; only the Graph view pays for them.
export const ConceptGraphLazy = dynamic(() => import("./ConceptGraph").then((m) => m.ConceptGraph), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-[12px] text-faint">Loading graph…</div>,
});
