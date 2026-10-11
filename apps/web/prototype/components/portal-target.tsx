import {
  type CSSProperties,
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
} from "react";

const PortalTargetContext = createContext<HTMLElement | null>(null);

/** Keeps contextual popovers in a modal's native top layer. */
export function PortalTargetProvider({
  target,
  children,
}: {
  target: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <PortalTargetContext.Provider value={target}>
      {children}
    </PortalTargetContext.Provider>
  );
}

/** Keep nonmodal overlays in the page scroll chain, without cancelling wheel events. */
export function usePortalTarget(anchor?: RefObject<HTMLElement | null>) {
  return (
    useContext(PortalTargetContext) ??
    anchor?.current?.closest("dialog") ??
    document.querySelector<HTMLElement>(".site-main") ??
    document.body
  );
}

/** Fixed overlays skip an inner scroller's containing block. Position ordinary
 * popovers in the main scroller instead; dialog overlays keep top-layer geometry. */
export function portalPosition(
  target: HTMLElement,
  position: CSSProperties,
  panel: HTMLElement | null,
): CSSProperties {
  if (!target.matches(".site-main")) return position;
  const bounds = target.getBoundingClientRect();
  const inset = 12;
  const width = Math.max(0, target.clientWidth - inset * 2);
  const height = Math.max(0, target.clientHeight - inset * 2);
  const panelWidth = Math.min(panel?.offsetWidth ?? 0, width);
  const panelHeight = Math.min(panel?.offsetHeight ?? 0, height);
  const originX = bounds.left + target.clientLeft;
  const originY = bounds.top + target.clientTop;
  const left = Math.max(
    originX + inset,
    Math.min(
      Number(position.left ?? 0),
      originX + target.clientWidth - inset - panelWidth,
    ),
  );
  const top = Math.max(
    originY + inset,
    Math.min(
      Number(position.top ?? 0),
      originY + target.clientHeight - inset - panelHeight,
    ),
  );
  return {
    ...position,
    position: "absolute",
    left: left - originX + target.scrollLeft,
    top: top - originY + target.scrollTop,
    maxWidth: width,
    maxHeight: height,
  };
}
