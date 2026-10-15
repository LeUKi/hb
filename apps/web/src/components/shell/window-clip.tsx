import { Slot } from "@radix-ui/react-slot";
import type { CSSProperties, ReactElement } from "react";
import { SMOOTHING, squirclePath } from "../../lib/squircle-path";
import { cornerShape, useNativeSquircle, withRing } from "../ui/squircle";
import { useWindowInfo } from "./window-info";

/**
 * Shapes a layer that starts at the window's top-left corner as the
 * window's squircle. Each full-window layer shapes itself — 玻璃层, 内容区,
 * 顶栏 and the 压暗层 — because a clip-path on a shared ancestor stops the
 * 顶栏's backdrop-filter from seeing the page that scrolls beneath it
 * (Chrome). They all read one size, so their shapes are identical; the 顶栏
 * (`top`) is only as tall as the bar, so just its top corners round.
 * Natively (CSS corner-shape) the layer keeps its own rounded, reshaped
 * corners; elsewhere the window's path is a clip-path, and a layer with a
 * `ring` (the 玻璃层's light edge) has it drawn along that path.
 */
export function WindowClip({
  children,
  top = false,
  ring = false,
}: {
  children: ReactElement;
  top?: boolean;
  ring?: boolean;
}) {
  const { width, height, radius } = useWindowInfo();
  const native = useNativeSquircle();
  if (radius <= 0) return children;
  if (native) {
    const shape = cornerShape(width, height, radius, SMOOTHING);
    const style: CSSProperties = top
      ? {
          borderTopLeftRadius: shape.borderRadius,
          borderTopRightRadius: shape.borderRadius,
          cornerShape: shape.cornerShape,
        }
      : { ...shape, overflow: "clip" };
    return (
      <Slot data-squircle="" style={style}>
        {children}
      </Slot>
    );
  }
  const path = squirclePath(0, 0, width, height, radius);
  return (
    <Slot data-squircle="" style={{ clipPath: `path('${path}')` }}>
      {ring
        ? withRing(children, path, {
            width,
            height,
            clips: false,
            scrolls: false,
          })
        : children}
    </Slot>
  );
}
