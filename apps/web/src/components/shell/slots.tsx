import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
} from "react";
import { layoutKey } from "./layout-morph";

// The omnibox is a single element that moves between "slots": invisible
// placeholders laid out by the start page, the window bar and the command
// position. Rects are relative to the stage (the omnibox's containing block),
// so a transform on the stage never skews them.

export type SlotName = "start" | "dock" | "command";
export type SlotRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The stage's side of the layout lines when measured (布局补间). */
  layout: string;
};

class SlotRegistry {
  private stage: HTMLElement | null = null;
  private readonly elements = new Map<SlotName, HTMLElement>();
  private readonly rects = new Map<SlotName, SlotRect>();
  private readonly listeners = new Set<() => void>();
  private readonly observer =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => this.schedule());
  private frame = 0;
  private readonly onScroll = () => this.schedule();

  setStage(element: HTMLElement | null) {
    if (this.stage) {
      this.observer?.unobserve(this.stage);
      this.stage.removeEventListener("scroll", this.onScroll, true);
    }
    this.stage = element;
    if (element) {
      this.observer?.observe(element);
      element.addEventListener("scroll", this.onScroll, true);
    }
    this.measure();
  }

  register(name: SlotName, element: HTMLElement) {
    const previous = this.elements.get(name);
    if (previous && previous !== element) this.observer?.unobserve(previous);
    this.elements.set(name, element);
    this.observer?.observe(element);
    this.measure();
  }

  unregister(name: SlotName, element: HTMLElement) {
    if (this.elements.get(name) !== element) return;
    this.elements.delete(name);
    this.observer?.unobserve(element);
    this.measure();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.measure();
    });
  }

  measure() {
    if (!this.stage) return;
    const base = this.stage.getBoundingClientRect();
    const layout = layoutKey(base.width);
    let changed = false;
    for (const name of this.rects.keys()) {
      if (!this.elements.has(name)) {
        this.rects.delete(name);
        changed = true;
      }
    }
    for (const [name, element] of this.elements) {
      const box = element.getBoundingClientRect();
      const next = {
        x: Math.round((box.left - base.left) * 2) / 2,
        y: Math.round((box.top - base.top) * 2) / 2,
        width: Math.round(box.width * 2) / 2,
        height: Math.round(box.height * 2) / 2,
        layout,
      };
      const current = this.rects.get(name);
      if (
        !current ||
        current.x !== next.x ||
        current.y !== next.y ||
        current.width !== next.width ||
        current.height !== next.height ||
        current.layout !== next.layout
      ) {
        this.rects.set(name, next);
        changed = true;
      }
    }
    if (changed) for (const listener of this.listeners) listener();
  }

  get(name: SlotName) {
    return this.rects.get(name);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

const SlotContext = createContext<SlotRegistry | null>(null);

export function SlotProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new SlotRegistry());
  return <SlotContext value={registry}>{children}</SlotContext>;
}

function useRegistry() {
  const registry = useContext(SlotContext);
  if (!registry) throw new Error("SlotProvider is missing");
  return registry;
}

/** Ref callback for the element the omnibox measures against. */
export function useSlotStage() {
  const registry = useRegistry();
  return useCallback(
    (element: HTMLElement | null) => {
      registry.setStage(element);
      return () => registry.setStage(null);
    },
    [registry],
  );
}

/**
 * Measures the slots now: the window's own resize work calls it, so the
 * omnibox is placed in the frame its slot moved, not the next.
 */
export function useMeasureSlots() {
  const registry = useRegistry();
  return useCallback(() => registry.measure(), [registry]);
}

/** Ref callback that registers an invisible placeholder for the omnibox. */
export function useSlot(name: SlotName) {
  const registry = useRegistry();
  return useCallback(
    (element: HTMLElement | null) => {
      if (!element) return;
      registry.register(name, element);
      return () => registry.unregister(name, element);
    },
    [registry, name],
  );
}

export function useSlotRect(name: SlotName) {
  const registry = useRegistry();
  return useSyncExternalStore(registry.subscribe, () => registry.get(name));
}
