"use client";
import { useEffect } from "react";

/** ⌘K / Ctrl+K focuses the topbar search. */
export function Hotkey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        const el = document.querySelector<HTMLInputElement>('[data-hotkey="k"]');
        if (el) {
          e.preventDefault();
          el.focus();
          el.select();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}
