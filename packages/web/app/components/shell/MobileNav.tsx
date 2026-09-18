"use client";
import { useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Brand } from "./Brand";
import { Nav, type NavCounts } from "./Nav";

export function MobileNav({ base, counts }: { base: string; counts: NavCounts }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
          <Menu className="h-4 w-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-[var(--sidebar-w)] p-0">
        <SheetTitle className="flex h-14 items-center px-4">
          <Brand />
        </SheetTitle>
        <Nav base={base} counts={counts} onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
