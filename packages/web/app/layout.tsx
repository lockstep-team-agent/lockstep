import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Lockstep",
  description: "Keep your team's coding agents in sync.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">
          <div className="logo">
            <span className="dot" /> Lockstep
          </div>
          {children}
        </div>
      </body>
    </html>
  );
}
