import "./globals.css";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { cn } from "@/lib/utils";
import { newUiEnabled } from "@/lib/next-data";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata = {
  title: "Lockstep",
  description: "Keep your team's coding agents in lockstep.",
};

// New shell only: apply the saved theme before first paint (no dark→light flash).
const THEME_SCRIPT = `try{var t=localStorage.getItem("lockstep:theme");if(t==="light"||(t!=="dark"&&matchMedia("(prefers-color-scheme: light)").matches))document.documentElement.classList.add("light")}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  const next = newUiEnabled();
  return (
    <html
      lang="en"
      className={cn(inter.variable, mono.variable, next && GeistSans.variable, next && GeistMono.variable)}
      suppressHydrationWarning={next}
    >
      {next && (
        <head>
          <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        </head>
      )}
      {/* .ui-next on <body> so Radix portals (menus, dialogs, the palette) inherit the new tokens */}
      <body className={cn("min-h-screen", next && "ui-next")}>{children}</body>
    </html>
  );
}
