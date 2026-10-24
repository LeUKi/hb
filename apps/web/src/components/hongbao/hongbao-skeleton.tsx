import { useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "../../lib/cn";
import { Bone } from "../page/page-state";
import { useWindowInfo } from "../shell/window-info";
import { hongbaoSizes, sizeVars } from "./hero";

/**
 * The 红包 page before its data arrives: the cover's red from the window's
 * top edge (a 代码判定红包's lacquer, when a list already said so), at the
 * size the cover will have (the small one for a 红包 already taken part in;
 * faded once it ended), cream bars where the sender, the title, the chips
 * and the 公开数据 go, and a grey bar where the hint will be. The page that
 * follows takes the cover on from this height (onMeasure) and fades in only
 * what is on it. After 重试 the focus waits here, on 正在读取….
 */
export function HongbaoSkeleton({
  focus,
  small,
  ended,
  code,
  onMeasure,
}: {
  focus: boolean;
  small: boolean;
  ended: boolean;
  code: boolean;
  onMeasure: (height: number) => void;
}) {
  const status = useRef<HTMLParagraphElement>(null);
  const cover = useRef<HTMLDivElement>(null);
  const info = useWindowInfo();
  useEffect(() => {
    if (focus) status.current?.focus({ preventScroll: true });
  }, [focus]);
  useLayoutEffect(() => {
    if (cover.current) onMeasure(cover.current.offsetHeight);
  });
  return (
    <div
      className="flex min-h-full flex-col"
      style={sizeVars(hongbaoSizes(info))}
    >
      <p
        ref={status}
        role="status"
        tabIndex={-1}
        className="sr-only outline-none"
      >
        正在读取…
      </p>
      <div
        aria-hidden="true"
        className={cn(
          "hb-cover-frame relative isolate",
          ended && "hb-ended",
          code && "hb-code",
        )}
      >
        <div
          ref={cover}
          className={cn(
            "hb-cover relative grid justify-items-center px-6",
            small
              ? "gap-3 pt-[calc(var(--bar-h)+0.875rem)] pb-[calc(var(--hb-curve)*0.55+0.75rem)]"
              : "min-h-(--hb-cover) content-center gap-4 pt-(--bar-h) pb-[calc(var(--seal)/2+1rem)]",
          )}
        >
          {small ? (
            <>
              <Bone red className="h-4 w-24" />
              <Bone red className="h-6 w-48 max-w-full" radius={8} />
              {/* The 说明 line: wide windows only, as on the small cover. */}
              {!info.compact && <Bone red className="h-4 w-64 max-w-full" />}
              <Bone red className="h-6 w-32" radius={7} />
            </>
          ) : (
            <>
              <Bone red className="h-5 w-28" />
              <Bone red className="h-8 w-60 max-w-full" radius={9} />
              <div className="flex gap-2">
                <Bone red className="h-6 w-16" radius={7} />
                <Bone red className="h-6 w-28" radius={7} />
              </div>
              <div className="mt-6 grid w-full max-w-[34rem] grid-cols-3 gap-4">
                {[0, 1, 2].map((cell) => (
                  <div key={cell} className="grid gap-2">
                    <Bone red className="h-3.5 w-12" />
                    <Bone red className="h-6 w-20 max-w-full" radius={6} />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <div
        aria-hidden="true"
        className="grid justify-items-center px-6"
        style={{ paddingTop: "calc(var(--seal) / 2 + 0.875rem)" }}
      >
        <Bone className="h-5 w-48" radius={6} />
      </div>
    </div>
  );
}
