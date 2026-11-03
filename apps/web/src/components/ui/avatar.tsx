import { useContext, useEffect, useReducer, useState } from "react";
import { AvatarSourceContext } from "../../lib/avatar-source";
import { cn } from "../../lib/cn";
import { useEmbedded } from "../../lib/embedded";

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
  // The 社区's mini app loads no pictures from elsewhere: the 社区's own
  // when it has lent one (AvatarSource), else the character.
  const embedded = useEmbedded();
  const source = useContext(AvatarSourceContext);
  const [, loaded] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (!embedded || !source || !src || source.peek(src) !== undefined) return;
    let live = true;
    void source.load(src).then(() => {
      if (live) loaded();
    });
    return () => {
      live = false;
    };
  }, [embedded, source, src]);
  const shown = embedded
    ? source && src
      ? (source.peek(src) ?? null)
      : null
    : (src ?? null);
  const picture = shown && failed !== shown ? shown : null;
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
