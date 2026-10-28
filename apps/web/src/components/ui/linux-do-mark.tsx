import { cn } from "../../lib/cn";

/**
 * LINUX DO's own logo, as its favicon draws it: a light ring round three
 * bands, dark, light and amber. Drawn without a clip path, so two on one
 * page share no ids.
 */
export function LinuxDoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="10 10 100 100"
      className={cn("linux-do-mark shrink-0", className)}
      aria-hidden="true"
    >
      <circle cx="60" cy="60" r="50" fill="#f0f0f0" />
      <path d="M17.47 40A47 47 0 0 1 102.53 40Z" fill="#1c1c1e" />
      <path d="M17.47 80A47 47 0 0 0 102.53 80Z" fill="#ffb003" />
    </svg>
  );
}
