import { cn } from "@/lib/utils";

/** The one place the violet→teal gradient survives: the logo mark. */
export function Brand({ className, size = "sm" }: { className?: string; size?: "sm" | "lg" }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        className={cn(
          "inline-block rounded-md bg-gradient-to-br from-[#a78bfa] to-[#2dd4bf]",
          size === "sm" ? "h-5 w-5" : "h-7 w-7",
        )}
        aria-hidden
      />
      <span className={cn("font-semibold", size === "lg" && "text-lg")}>Lockstep</span>
    </span>
  );
}
