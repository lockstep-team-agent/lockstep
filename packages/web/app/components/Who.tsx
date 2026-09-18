import Link from "next/link";
import { cn } from "@/lib/utils";

/** Avatar initial + @login. Links to Members when `href` is given. */
export function Who({
  login,
  role,
  size = "sm",
  href,
  className,
}: {
  login: string;
  role?: string;
  size?: "sm" | "md";
  href?: string;
  className?: string;
}) {
  const initial = (login[0] ?? "?").toUpperCase();
  const body = (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-muted-foreground", className)}>
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-md bg-primary-soft font-semibold text-primary",
          size === "sm" ? "h-5 w-5 text-[10px]" : "h-7 w-7 text-xs",
        )}
        aria-hidden
      >
        {initial}
      </span>
      <span className="truncate">@{login}</span>
      {role && <span className="text-xs">· {role}</span>}
    </span>
  );
  return href ? (
    <Link href={href} className="hover:text-foreground">
      {body}
    </Link>
  ) : (
    body
  );
}
