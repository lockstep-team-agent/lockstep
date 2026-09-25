"use client";
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

export function toggleTheme(): void {
  const light = !document.documentElement.classList.contains("light");
  document.documentElement.classList.toggle("light", light);
  try {
    localStorage.setItem("lockstep:theme", light ? "light" : "dark");
  } catch {
    /* private mode — the toggle still works for this page */
  }
  window.dispatchEvent(new Event("lockstep:theme"));
}

export function ThemeToggle() {
  const [light, setLight] = useState(false);
  useEffect(() => {
    const sync = () => setLight(document.documentElement.classList.contains("light"));
    sync();
    window.addEventListener("lockstep:theme", sync);
    return () => window.removeEventListener("lockstep:theme", sync);
  }, []);
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={light ? "Switch to dark theme" : "Switch to light theme"}
      className="press flex h-8 w-8 items-center justify-center rounded-md text-faint transition-colors duration-150 hover:bg-muted hover:text-foreground"
    >
      {light ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
    </button>
  );
}
