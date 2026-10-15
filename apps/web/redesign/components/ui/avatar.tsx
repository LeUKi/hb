import { cn } from "../../lib/cn";

/** Initial avatar on the gold ring; the same treatment for every person. */
export function Avatar({
  name,
  size = 32,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "avatar-ring inline-grid shrink-0 select-none place-items-center rounded-full font-medium",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {Array.from(name)[0] ?? "?"}
    </span>
  );
}
