"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

const GO: Record<string, string> = { i: "inbox", m: "map", l: "ledger", n: "insights", s: "settings" };

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

/**
 * Global keys: `g i|m|l|n|s` navigate; `j`/`k` move between [data-row] rows of the page and
 * Enter opens the focused row's [data-row-link]. Rows are real focusable elements, so Tab works too.
 */
export function Shortcuts({ base }: { base: string }) {
  const router = useRouter();
  useEffect(() => {
    let g = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key === "g") {
        g = Date.now();
        return;
      }
      if (g && Date.now() - g < 800 && GO[e.key]) {
        g = 0;
        e.preventDefault();
        router.push(`${base}/${GO[e.key]}`);
        return;
      }
      if (e.key === "j" || e.key === "k") {
        const rows = [...document.querySelectorAll<HTMLElement>("[data-row]")];
        if (rows.length === 0) return;
        e.preventDefault();
        const i = rows.findIndex((r) => r === document.activeElement || r.contains(document.activeElement));
        const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + (e.key === "j" ? 1 : -1)))]!;
        next.focus();
        next.scrollIntoView({ block: "nearest" });
      }
      if (
        e.key === "Enter" &&
        document.activeElement instanceof HTMLElement &&
        document.activeElement.dataset.row !== undefined
      ) {
        const link = document.activeElement.querySelector<HTMLElement>("[data-row-link]");
        if (link) {
          e.preventDefault();
          link.click();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [base, router]);
  return null;
}
