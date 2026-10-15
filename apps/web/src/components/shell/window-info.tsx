import {
  createContext,
  type RefObject,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { flushSync } from "react-dom";

export type WindowInfo = {
  width: number;
  height: number;
  compact: boolean;
  roomy: boolean;
  /** Corner radius of the window's squircle; 0 when it fills the screen. */
  radius: number;
};

const WindowInfoContext = createContext<WindowInfo>({
  width: 1200,
  height: 800,
  compact: false,
  roomy: true,
  radius: 0,
});

export const WindowInfoProvider = WindowInfoContext;

/** Size of the app window; layout reacts to the window, not the viewport. */
export function useWindowInfo() {
  return useContext(WindowInfoContext);
}

/**
 * A phone, as far as the 指令框 goes: a narrow window, or one that fills the
 * screen (a phone turned sideways is wide, but still full-screen).
 */
export function isPhoneLike(info: WindowInfo) {
  return info.compact || info.radius === 0;
}

let latest: WindowInfo | null = null;

/** The latest measurement, for decisions made outside rendering. */
export function phoneLikeNow() {
  return latest !== null && isPhoneLike(latest);
}

/**
 * The window's border box in fractional px, so every layer's squircle clip
 * matches the glass exactly; resizes commit before the next paint.
 */
export function useMeasuredWindow(
  ref: RefObject<HTMLElement | null>,
  radius: number,
): WindowInfo {
  const [size, setSize] = useState({ width: 1200, height: 800 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const apply = (width: number, height: number) =>
      setSize((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    const box = element.getBoundingClientRect();
    apply(box.width, box.height);
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.borderBoxSize?.[0];
      if (next) flushSync(() => apply(next.inlineSize, next.blockSize));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  const info = useMemo(
    () => ({
      ...size,
      compact: size.width < 640,
      // Room for a page beside a side column (list + detail); below it
      // those pages go to one column.
      roomy: size.width >= 960,
      radius,
    }),
    [size, radius],
  );
  useLayoutEffect(() => {
    latest = info;
  }, [info]);
  return info;
}
