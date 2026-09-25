"use client";
import { Search } from "lucide-react";
import { openPalette } from "./CommandPalette";

export function PaletteButton() {
  return (
    <button
      type="button"
      onClick={openPalette}
      className="flex h-8 w-full items-center gap-2 rounded-md border bg-muted px-2 text-[13px] text-faint transition-colors duration-150 hover:border-border-strong hover:text-muted-foreground"
    >
      <Search className="h-3.5 w-3.5" />
      <span className="flex-1 text-left">Search</span>
      <kbd className="font-mono text-[10px]">⌘K</kbd>
    </button>
  );
}
