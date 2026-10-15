import { useState } from "react";
import { cn } from "../../lib/cn";

/**
 * A person on the gold ring, the same treatment for everyone: their forum
 * avatar when there is one, else the first character of their name (also
 * when the picture fails to load).
 */
export function Avatar({
  name,
  src,
  size = 32,
  className,
}: {
  name: string;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const picture = src && failed !== src ? src : null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "avatar-ring inline-grid shrink-0 select-none place-items-center overflow-hidden rounded-full font-medium",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {picture ? (
        <img
          src={picture}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(picture)}
          className="size-full rounded-full object-cover"
        />
      ) : (
        (Array.from(name)[0] ?? "?")
      )}
    </span>
  );
}
