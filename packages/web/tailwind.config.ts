import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

/**
 * Tailwind maps every colour name to a CSS variable (see app/globals.css) — dark is :root, light is
 * `.light` on <html>. Alpha variants are explicit `-soft` / `-edge` tokens rather than opacity
 * modifiers, so shadcn components work unchanged and the palette stays one file.
 */
export default {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1.5rem", screens: { "2xl": "1200px" } },
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: { DEFAULT: "var(--card)", foreground: "var(--foreground)" },
        popover: { DEFAULT: "var(--card)", foreground: "var(--foreground)" },
        muted: { DEFAULT: "var(--muted)", foreground: "var(--muted-foreground)" },
        accent: { DEFAULT: "var(--muted)", foreground: "var(--foreground)" },
        secondary: { DEFAULT: "var(--muted)", foreground: "var(--foreground)" },
        border: "var(--border)",
        input: "var(--border)",
        ring: "var(--ring)",
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
          soft: "var(--primary-soft)",
          edge: "var(--primary-edge)",
        },
        success: { DEFAULT: "var(--success)", soft: "var(--success-soft)", edge: "var(--success-edge)" },
        warning: { DEFAULT: "var(--warning)", soft: "var(--warning-soft)", edge: "var(--warning-edge)" },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--foreground)",
          soft: "var(--destructive-soft)",
          edge: "var(--destructive-edge)",
        },
        info: { DEFAULT: "var(--info)", soft: "var(--info-soft)", edge: "var(--info-edge)" },
      },
      borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 2px)", sm: "calc(var(--radius) - 4px)" },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      fontSize: {
        "2xs": ["11px", { lineHeight: "16px", letterSpacing: "0.06em" }],
        xs: ["12px", { lineHeight: "16px" }],
        sm: ["13px", { lineHeight: "20px" }],
        base: ["14px", { lineHeight: "20px" }],
        lg: ["16px", { lineHeight: "24px" }],
        xl: ["20px", { lineHeight: "28px" }],
      },
      keyframes: {
        "accordion-down": { from: { height: "0" }, to: { height: "var(--radix-accordion-content-height)" } },
        "accordion-up": { from: { height: "var(--radix-accordion-content-height)" }, to: { height: "0" } },
      },
      animation: { "accordion-down": "accordion-down 0.2s ease-out", "accordion-up": "accordion-up 0.2s ease-out" },
    },
  },
  plugins: [animate],
} satisfies Config;
