import {
  Link,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import {
  type AnchorHTMLAttributes,
  createContext,
  type Dispatch,
  Fragment,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";

const overlaySchemaVersion = 2;
type Overlay = {
  kind: string;
  id?: string;
  parent: string;
  owner: string;
  version: typeof overlaySchemaVersion;
};
declare module "@tanstack/react-router" {
  interface HistoryState {
    hbVisit?: string;
    hbReset?: string;
    hbOverlay?: Overlay;
    hbOpenPublicActivities?: "all" | "active" | "ended";
  }
}

const prefix = "hb-navigation-v2:";
type Snapshot = {
  owner: string;
  path: string;
  values: Record<string, unknown>;
};
const snapshots = new Map<string, Snapshot>();
const listeners = new Set<() => void>();
const IdentityContext = createContext("guest");
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function read(key: string, owner: string, path: string): Snapshot {
  const cached = snapshots.get(key);
  if (cached?.owner === owner && cached.path === path) return cached;
  let snapshot: Snapshot = { owner, path, values: {} };
  try {
    const stored = JSON.parse(sessionStorage.getItem(prefix + key) ?? "null");
    if (
      stored?.owner === owner &&
      stored.path === path &&
      stored.values &&
      typeof stored.values === "object"
    )
      snapshot = stored;
  } catch {
    /* Storage is optional, including in private browser modes. */
  }
  snapshots.set(key, snapshot);
  return snapshot;
}
function persist(key: string, snapshot: Snapshot) {
  snapshots.set(key, snapshot);
  try {
    sessionStorage.setItem(prefix + key, JSON.stringify(snapshot));
  } catch {
    /* Keep the in-memory fallback. */
  }
}
function validShape(value: unknown, initial: unknown): boolean {
  if (initial === null) return value === null || typeof value === "string";
  if (Array.isArray(initial))
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => item === null || typeof item === "string")
    );
  if (typeof initial === "object")
    return (
      Boolean(value) &&
      typeof value === "object" &&
      Object.entries(initial as Record<string, unknown>).every(
        ([name, sample]) =>
          validShape((value as Record<string, unknown>)[name], sample),
      )
    );
  return typeof value === typeof initial;
}
export function clearNavigationState(owner?: string) {
  for (const [key, value] of snapshots)
    if (!owner || value.owner === owner) snapshots.delete(key);
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (!key.startsWith(prefix)) continue;
      if (!owner || key.startsWith(`${prefix}${owner}:`))
        sessionStorage.removeItem(key);
    }
  } catch {
    /* No private data is required to restore a page. */
  }
  emit();
}
export function navigationVisit(location: {
  state: { hbVisit?: string; hbReset?: string; __TSR_key?: string };
  href: string;
}) {
  return location.state.hbVisit ?? location.state.__TSR_key ?? location.href;
}

export function NavigationStateProvider({
  identity,
  children,
}: {
  identity: string;
  children: ReactNode;
}) {
  const previous = useRef(identity);
  useLayoutEffect(() => {
    if (previous.current !== identity && previous.current !== "pending")
      clearNavigationState(previous.current);
    if (identity !== "pending") {
      try {
        const priorOwner = sessionStorage.getItem("hb-navigation-owner");
        if (priorOwner && priorOwner !== identity)
          clearNavigationState(priorOwner);
        sessionStorage.setItem("hb-navigation-owner", identity);
      } catch {
        /* Restricted storage still supports in-memory navigation. */
      }
    }
    previous.current = identity;
  }, [identity]);
  return (
    <IdentityContext.Provider value={identity}>
      {children}
    </IdentityContext.Provider>
  );
}

function useEntry() {
  const owner = useContext(IdentityContext);
  const location = useRouterState({ select: (state) => state.location });
  const visit = navigationVisit(location);
  return { owner, location, visit, key: `${owner}:${visit}` };
}

/** Only explicit, non-sensitive view values belong here, never API responses or inputs. */
export function useViewState<T>(
  name: string,
  initial: T,
  scope = "",
): [T, Dispatch<SetStateAction<T>>] {
  const { owner, location, key } = useEntry();
  const field = `${name}:${scope}`;
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const get = useCallback(() => {
    const snapshot = read(key, owner, location.pathname);
    return (
      Object.hasOwn(snapshot.values, field) &&
      validShape(snapshot.values[field], initialRef.current)
        ? snapshot.values[field]
        : initialRef.current
    ) as T;
  }, [key, owner, location.pathname, field]);
  // An absent field must retain a stable identity until its scope changes.
  const fallback = useRef({ field: `${key}:${field}`, value: initial });
  if (fallback.current.field !== `${key}:${field}`)
    fallback.current = { field: `${key}:${field}`, value: initial };
  initialRef.current = fallback.current.value;
  const value = useSyncExternalStore(subscribe, get, get);
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      if (owner === "pending") return;
      const snapshot = read(key, owner, location.pathname);
      const current = (
        Object.hasOwn(snapshot.values, field) &&
        validShape(snapshot.values[field], initialRef.current)
          ? snapshot.values[field]
          : initialRef.current
      ) as T;
      const result =
        typeof next === "function" ? (next as (value: T) => T)(current) : next;
      if (Object.is(current, result)) return;
      persist(key, {
        ...snapshot,
        values: { ...snapshot.values, [field]: result },
      });
      emit();
    },
    [key, owner, location.pathname, field],
  );
  return [value, set];
}

export function useEntryNavigate() {
  const navigate = useNavigate();
  const router = useRouter();
  const owner = useContext(IdentityContext);
  return useCallback<typeof navigate>(
    (options) => {
      const current = router.state.location;
      const supplied = options.state;
      const nextVisit = options.replace
        ? navigationVisit(current)
        : crypto.randomUUID();
      if (!options.replace && options.to === current.pathname) {
        const source = read(
          `${owner}:${navigationVisit(current)}`,
          owner,
          current.pathname,
        );
        persist(`${owner}:${nextVisit}`, {
          ...source,
          values: { ...source.values },
        });
      }
      return navigate({
        ...options,
        state: (state) => ({
          ...(options.replace ? state : {}),
          ...(typeof supplied === "function"
            ? supplied(state)
            : supplied === true
              ? state
              : supplied || {}),
          hbOverlay:
            options.to && options.to !== current.pathname
              ? undefined
              : options.replace
                ? current.state.hbOverlay
                : undefined,
          hbReset:
            options.to === current.pathname ? current.state.hbReset : undefined,
          hbVisit: nextVisit,
        }),
      } as typeof options);
    },
    [navigate, router, owner],
  );
}

export function useCursorRecovery(
  error: unknown,
  cursors: Array<string | null>,
  setCursors: Dispatch<SetStateAction<Array<string | null>>>,
) {
  const [notice, setNotice] = useViewState("cursor-recovery-notice", false);
  useEffect(() => {
    if (
      cursors.length > 1 &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "INVALID_CURSOR"
    ) {
      setCursors([null]);
      setNotice(true);
    }
  }, [error, cursors.length, setCursors, setNotice]);
  return notice ? (
    <p className="refresh-notice" role="status">
      分页位置已失效，已返回第一页。
    </p>
  ) : null;
}

export function useFreshNavigation() {
  const router = useRouter();
  const navigate = useNavigate();
  return useCallback(
    (to: string) => {
      const visit = crypto.randomUUID();
      return navigate({
        to,
        search: {},
        replace: router.state.location.pathname === to,
        state: { hbVisit: visit, hbReset: visit },
      });
    },
    [navigate, router],
  );
}

/** Real links retain modifier-click and native browser menus. */
export function FreshLink({
  to,
  children,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  to: string;
  children: ReactNode;
}) {
  const fresh = useFreshNavigation();
  return (
    <Link
      {...props}
      to={to}
      search={() => ({})}
      onClick={(event) => {
        props.onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        void fresh(to);
      }}
    >
      {children}
    </Link>
  );
}

export function useHistoryOverlay(kind: string, scope = "") {
  const router = useRouter();
  const navigate = useNavigate();
  const { owner, location, visit, key } = useEntry();
  const overlayOwner = scope ? `${owner}:${scope}` : owner;
  const opening = useRef(false);
  const candidate = location.state.hbOverlay;
  const overlay =
    candidate?.kind === kind &&
    candidate.owner === overlayOwner &&
    candidate.version === overlaySchemaVersion
      ? candidate
      : null;
  const open = (id?: string) => {
    if (opening.current || (overlay?.id === id && overlay)) return;
    opening.current = true;
    const nextVisit = crypto.randomUUID();
    const source = read(key, owner, location.pathname);
    persist(`${owner}:${nextVisit}`, {
      ...source,
      values: { ...source.values },
    });
    void navigate({
      to: location.pathname,
      search: location.search,
      hash: location.hash,
      resetScroll: false,
      state: {
        hbVisit: nextVisit,
        hbReset: location.state.hbReset,
        hbOverlay: {
          kind,
          id,
          parent: visit,
          owner: overlayOwner,
          version: overlaySchemaVersion,
        },
      },
    }).finally(() => {
      opening.current = false;
    });
  };
  const close = () => {
    if (overlay) router.history.back();
  };
  const discard = () => {
    if (overlay)
      void navigate({
        to: location.pathname,
        search: location.search,
        replace: true,
        resetScroll: false,
        state: { ...location.state, hbOverlay: undefined, hbVisit: visit },
      });
  };
  return { overlay, open, close, discard };
}

type ScrollPosition = {
  top: number;
  left: number;
  anchor?: string;
  offset?: number;
  height?: number;
};
function anchorNodes(node: HTMLElement) {
  return Array.from(
    node.querySelectorAll<HTMLElement>("[data-activity-id], [data-record-id]"),
  );
}
function recordId(node: HTMLElement) {
  return node.dataset.activityId ?? node.dataset.recordId;
}

export function useRestoredScroll(
  ref: RefObject<HTMLElement | null>,
  id: string,
  ready = true,
  resetKey = "",
) {
  const { owner, location, key, visit } = useEntry();
  const router = useRouter();
  const field = `scroll:${id}:${resetKey}`;
  const scope = useRef({ key, field, reset: false });
  if (scope.current.key !== key) scope.current = { key, field, reset: false };
  else if (scope.current.field !== field)
    scope.current = { key, field, reset: true };
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || owner === "pending") return;
    node.dataset.scrollRestorationId = `${owner}:${id}`;
    const snapshot = read(key, owner, location.pathname);
    const candidate = snapshot.values[field] as ScrollPosition | undefined;
    const saved =
      !scope.current.reset &&
      candidate &&
      Number.isFinite(candidate.top) &&
      Number.isFinite(candidate.left)
        ? candidate
        : undefined;
    let restoring = Boolean(saved) || scope.current.reset;
    if (id === "main" && saved && saved.top > 0)
      node.dataset.navigationRestoring = "true";
    let cancelled = false;
    const save = () => {
      // Closing a native modal releases its top layer before route navigation.
      // Hidden geometry must not overwrite the last visible reading position.
      if (
        restoring ||
        (node.closest("dialog") && !node.closest("dialog")?.open)
      )
        return;
      const bounds = node.getBoundingClientRect();
      const anchor = anchorNodes(node).find(
        (row) => row.getBoundingClientRect().bottom > bounds.top,
      );
      const value: ScrollPosition = {
        top: node.scrollTop,
        left: node.scrollLeft,
        height: node.scrollHeight,
        ...(anchor
          ? {
              anchor: recordId(anchor),
              offset: anchor.getBoundingClientRect().top - bounds.top,
            }
          : {}),
      };
      const current = read(key, owner, location.pathname);
      persist(key, {
        ...current,
        values: { ...current.values, [field]: value },
      });
    };
    const restore = () => {
      if (
        cancelled ||
        !ready ||
        (node.closest("dialog") && !node.closest("dialog")?.open)
      )
        return;
      const pending = node.querySelector(
        '[aria-busy="true"], [data-loading-region="page"], [data-layout-settling="true"]',
      );
      if (pending) return;
      if (saved) {
        const anchor =
          saved.anchor &&
          anchorNodes(node).find((row) => recordId(row) === saved.anchor);
        node.scrollTop = anchor
          ? node.scrollTop +
            anchor.getBoundingClientRect().top -
            node.getBoundingClientRect().top -
            (saved.offset ?? 0)
          : saved.top;
        node.scrollLeft = saved.left;
      } else node.scrollTop = 0;
      restoring = false;
      delete node.dataset.navigationRestoring;
      scope.current.reset = false;
      cancelled = true;
    };
    const stop = () => {
      restoring = false;
      cancelled = true;
      delete node.dataset.navigationRestoring;
    };
    const keydown = (event: KeyboardEvent) => {
      if (
        [
          "PageDown",
          "PageUp",
          "Home",
          "End",
          "ArrowDown",
          "ArrowUp",
          " ",
        ].includes(event.key)
      )
        stop();
    };
    const observer = new MutationObserver(restore);
    observer.observe(node, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "aria-busy",
        "data-loading-region",
        "data-layout-settling",
      ],
    });
    restore();
    const frame = requestAnimationFrame(restore);
    node.addEventListener("scroll", save, { passive: true });
    node.addEventListener("wheel", stop, { passive: true });
    node.addEventListener("touchstart", stop, { passive: true });
    node.addEventListener("keydown", keydown);
    window.addEventListener("pagehide", save);
    const unsubscribe = router.subscribe("onBeforeNavigate", save);
    return () => {
      delete node.dataset.navigationRestoring;
      cancelAnimationFrame(frame);
      unsubscribe();
      if (navigationVisit(router.state.location) === visit) save();
      observer.disconnect();
      node.removeEventListener("scroll", save);
      node.removeEventListener("wheel", stop);
      node.removeEventListener("touchstart", stop);
      node.removeEventListener("keydown", keydown);
      window.removeEventListener("pagehide", save);
    };
  }, [ref, id, key, owner, location.pathname, ready, field, router, visit]);
}

/** Main scroll and ordinary disclosure state; inputs and private text are never captured. */
export function NavigationViewport({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement | null>(null);
  const { key, owner, location } = useEntry();
  const router = useRouter();
  useLayoutEffect(() => {
    ref.current = document.getElementById("main");
  }, []);
  useRestoredScroll(ref, "main");
  useEffect(() => {
    let lastFocus: { row?: string; index: number; id?: string } | undefined;
    const capture = () => {
      const active = document.activeElement;
      if (
        !(active instanceof HTMLElement) ||
        !ref.current?.contains(active) ||
        active.matches("input,textarea,select") ||
        active.closest("dialog")
      )
        return;
      const row = active.closest<HTMLElement>(
        "[data-activity-id], [data-record-id]",
      );
      const controls = Array.from(
        (row ?? ref.current ?? document.body).querySelectorAll<HTMLElement>(
          "a,button,[tabindex='0']",
        ),
      );
      const focus = {
        row: row ? recordId(row) : undefined,
        index: controls.indexOf(active),
        id: active.id || undefined,
      };
      if (focus.index >= 0 || focus.id) lastFocus = focus;
    };
    document.addEventListener("focusin", capture);
    const unsubscribe = router.subscribe("onBeforeNavigate", () => {
      capture();
      if (!lastFocus) return;
      const snapshot = read(key, owner, location.pathname);
      persist(key, {
        ...snapshot,
        values: { ...snapshot.values, focus: lastFocus },
      });
    });
    return () => {
      document.removeEventListener("focusin", capture);
      unsubscribe();
    };
  }, [router, key, owner, location.pathname]);
  useEffect(() => {
    const focus = read(key, owner, location.pathname).values.focus as
      | { row?: string; index: number; id?: string }
      | undefined;
    if (!focus || !Number.isInteger(focus.index) || focus.index < 0) return;
    const restore = () => {
      const root = ref.current;
      if (
        !root ||
        root.querySelector('[aria-busy="true"]') ||
        document.querySelector("dialog[open]")
      )
        return false;
      const row = focus.row
        ? anchorNodes(root).find((node) => recordId(node) === focus.row)
        : root;
      if (!row) return false;
      const target = focus.id
        ? document.getElementById(focus.id)
        : Array.from(
            row.querySelectorAll<HTMLElement>("a,button,[tabindex='0']"),
          )[focus.index];
      if (!target || !root.contains(target)) return false;
      target.focus({ preventScroll: true });
      return true;
    };
    if (restore()) return;
    const observer = new MutationObserver(() => {
      if (restore()) observer.disconnect();
    });
    if (ref.current)
      observer.observe(ref.current, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["aria-busy"],
      });
    const stop = () => observer.disconnect();
    document.addEventListener("pointerdown", stop, { once: true });
    document.addEventListener("keydown", stop, { once: true });
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", stop);
      document.removeEventListener("keydown", stop);
    };
  }, [key, owner, location.pathname]);
  return (
    <Fragment key={location.state.hbReset ?? "initial"}>{children}</Fragment>
  );
}

/** Shared animation geometry is measured after the destination scroll settles. */
export function afterNavigationLayout(
  start: () => (() => void) | undefined,
  waitForActivity = false,
) {
  let cleanup: (() => void) | undefined;
  let frame = 0;
  const measure = () => {
    if (
      document.getElementById("main")?.dataset.navigationRestoring === "true" ||
      document.querySelector('.activity-page [data-layout-settling="true"]') ||
      (waitForActivity &&
        document.querySelector('.activity-page[data-entry-ready="false"]'))
    ) {
      frame = requestAnimationFrame(measure);
      return;
    }
    cleanup = start();
  };
  frame = requestAnimationFrame(measure);
  return () => {
    cancelAnimationFrame(frame);
    cleanup?.();
  };
}
