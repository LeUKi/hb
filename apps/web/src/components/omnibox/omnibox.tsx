import { activityPath, readShareText } from "@hb/contracts";
import { useLocation } from "@tanstack/react-router";
import { useAtom, useAtomValue, useStore } from "jotai";
import { X } from "lucide-react";
import {
  AnimatePresence,
  type AnimationPlaybackControls,
  animate,
  motion,
  useMotionValue,
  useTransform,
} from "motion/react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useActivityFacts } from "../../lib/activity-facts";
import { useCurrentActivityId } from "../../lib/activity-route";
import { featuresOf, roleOf } from "../../lib/commands";
import { durations, ease, useReducedMotionPref } from "../../lib/motion";
import { inspectPassword } from "../../lib/password-rules";
import { isOpenShortcut } from "../../lib/platform";
import { useRecentInputs } from "../../lib/recent-inputs";
import {
  detectScheme,
  type EntryScheme,
  isJumpScheme,
  looksLikeAddress,
} from "../../lib/scheme";
import { useSessionUser } from "../../lib/session";
import { viewEdgeAtom, windowDialogsAtom } from "../../lib/store";
import { JudgmentRecord } from "../hongbao/my-judgments";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { keyboardInsetAtom } from "../shell/keyboard";
import { MORPH_MS } from "../shell/layout-morph";
import { type SlotRect, useSlotRect } from "../shell/slots";
import { isPhoneLike, useWindowInfo } from "../shell/window-info";
import {
  Button,
  buttonHeight,
  buttonRadius,
  buttonVariants,
  useButtonShape,
} from "../ui/button";
import { ShortcutKbd, Spinner } from "../ui/kbd";
import { MorphLabel, RollingNumber } from "../ui/morph-label";
import { Squircle, SquircleFill, SquirclePlate } from "../ui/squircle";
import { AddressRoller, useAddress } from "./address";
import { SchemeChip, ScopeChip } from "./chips";
import { OmniboxField } from "./field";
import { IdleHintText, useIdleHint } from "./idle-hint";
import { MessageLine, resolveMessage } from "./message";
import {
  editDraftAtom,
  editLinesAtom,
  messageAtom,
  mismatchAtom,
  omniboxMetrics,
  pastedPasswordAtom,
  pendingAtom,
  type Scope,
  type ScopeOffer,
  scopeAtom,
  startDraftAtom,
  startHintElementAtom,
  startLinesAtom,
  unconfirmedAtom,
  useOmniboxMode,
} from "./state";
import {
  buildSuggestions,
  optimizeTarget,
  type Suggestion,
  SuggestionPanel,
} from "./suggestions";
import {
  focusOmniboxInput,
  omniboxElements,
  useCooldownSeconds,
  useOmniboxController,
  useScopeOffer,
} from "./use-omnibox-controller";

const LISTBOX_ID = "omnibox-suggestions";

type Chrome = "start" | "expanded" | "docked-top";

/** Squircle radius per state: centred box, or recessed in the 顶栏. */
function chromeRadius(chrome: Chrome, compact: boolean) {
  if (chrome === "docked-top") return compact ? 12 : 14;
  return compact ? 20 : 22;
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

/**
 * Moves one element between slots by animating real geometry (no scale); the
 * corner radius travels with it so the squircle reshapes in the same flight.
 * The window crossing a line its layout changes at (布局补间) moves the slot
 * at once while the window may still be resizing: there the box keeps to
 * its slot every frame, and only the jump fades out (an offset to nothing),
 * so it never trails the rest of the window.
 */
function useSlotGeometry(
  target: SlotRect | undefined,
  modeKey: string,
  cornerRadius: number,
) {
  const reduced = useReducedMotionPref();
  // Where the slot is, and the jump still fading out after a crossing.
  const baseX = useMotionValue(0);
  const baseY = useMotionValue(0);
  const baseWidth = useMotionValue(0);
  const baseHeight = useMotionValue(0);
  const shiftX = useMotionValue(0);
  const shiftY = useMotionValue(0);
  const shiftWidth = useMotionValue(0);
  const shiftHeight = useMotionValue(0);
  const x = useTransform(() => baseX.get() + shiftX.get());
  const y = useTransform(() => baseY.get() + shiftY.get());
  const width = useTransform(() => baseWidth.get() + shiftWidth.get());
  const height = useTransform(() => baseHeight.get() + shiftHeight.get());
  const radius = useMotionValue(cornerRadius);
  const element = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState(false);
  const pending = useRef(false);
  const crossed = useRef(false);
  /** When the last crossing was, and where each step of it started. */
  const crossedAt = useRef(Number.NEGATIVE_INFINITY);
  const step = useRef<number[]>([]);
  /** The slot as last followed, and the frame before: its pace. */
  const followed = useRef<{ at: number; rect: SlotRect }[]>([]);
  const lastKey = useRef(modeKey);
  const lastLayout = useRef(target?.layout);
  const flight = useRef<{
    until: number;
    controls: AnimationPlaybackControls[];
  } | null>(null);

  useLayoutEffect(() => {
    if (lastKey.current !== modeKey) {
      lastKey.current = modeKey;
      pending.current = true;
    }
  }, [modeKey]);
  useLayoutEffect(() => {
    if (lastLayout.current !== target?.layout) {
      if (lastLayout.current !== undefined) crossed.current = true;
      lastLayout.current = target?.layout;
    }
  }, [target?.layout]);

  useLayoutEffect(() => {
    if (!target) return;
    // Where it is now, onto the page in this frame: motion would write the
    // same next frame, a frame behind its slot while the window resizes.
    const paint = () => {
      const box = element.current;
      if (!box) return;
      // From the values themselves: the sums are worked out a frame later.
      box.style.transform = `translateX(${baseX.get() + shiftX.get()}px) translateY(${baseY.get() + shiftY.get()}px)`;
      box.style.width = `${baseWidth.get() + shiftWidth.get()}px`;
      box.style.height = `${baseHeight.get() + shiftHeight.get()}px`;
    };
    const pairs = [
      [baseX, shiftX, target.x],
      [baseY, shiftY, target.y],
      [baseWidth, shiftWidth, target.width],
      [baseHeight, shiftHeight, target.height],
    ] as const;
    const stop = () => {
      for (const control of flight.current?.controls ?? []) control.stop();
      flight.current = null;
    };
    const fly = (seconds: number) => {
      for (const control of flight.current?.controls ?? []) control.stop();
      flight.current = {
        until: performance.now() + seconds * 1000,
        controls: [
          ...pairs.map(([value, , to]) =>
            animate(value, to, { duration: seconds, ease }),
          ),
          animate(radius, cornerRadius, { duration: seconds, ease }),
        ],
      };
    };
    if (!placed || reduced) {
      stop();
      for (const [value, shift, to] of pairs) {
        value.jump(to);
        shift.jump(0);
      }
      radius.jump(cornerRadius);
      pending.current = false;
      crossed.current = false;
      paint();
      if (!placed) setPlaced(true);
      return;
    }
    if (pending.current) {
      pending.current = false;
      crossed.current = false;
      fly(durations.travel);
      return;
    }
    const now = performance.now();
    const keys = ["x", "y", "width", "height"] as const;
    // The slot as followed, one a frame (two reads in a frame are not a
    // pace), crossing frames too: the next crossing's pace starts there.
    const remember = (at: number) => {
      const kept = followed.current.filter((entry) => at - entry.at > 8);
      followed.current = [...kept, { at, rect: target }].slice(-2);
    };
    if (crossed.current) {
      crossed.current = false;
      crossedAt.current = now;
      // Where the slot would be this frame at the pace of the two frames
      // before: the crossing's jump is what it is beyond that.
      const [before, last] = followed.current.slice(-2);
      step.current = keys.map((key) => {
        if (!last || now - last.at > 80) return target[key];
        if (!before || last.at - before.at > 80) return last.rect[key];
        return last.rect[key] + (last.rect[key] - before.rect[key]);
      });
    }
    // In the crossing's frame the slot may move in steps (the page's own
    // rules first, its parts a moment later): each step's jump fades out
    // (MORPH_MS, as the rest of the window), never the pace it keeps.
    if (now - crossedAt.current < 14) {
      pairs.forEach(([value, shift, to], index) => {
        const from = step.current[index] ?? to;
        step.current[index] = to;
        value.stop();
        value.jump(to);
        if (Math.abs(to - from) < 1) return;
        shift.jump(shift.get() + from - to);
        animate(shift, 0, { duration: MORPH_MS / 1000, ease });
      });
      animate(radius, cornerRadius, { duration: MORPH_MS / 1000, ease });
      flight.current = null;
      remember(now);
      paint();
      return;
    }
    if (flight.current && now < flight.current.until) {
      // Slot moved mid-flight: retarget with the remaining time.
      fly(Math.max(0.08, (flight.current.until - now) / 1000));
      return;
    }
    stop();
    for (const [value, , to] of pairs) value.jump(to);
    remember(now);
    paint();
    // Outside a flight the corner changes with the layout: it eases there.
    if (Math.abs(radius.get() - cornerRadius) > 0.5)
      animate(radius, cornerRadius, { duration: MORPH_MS / 1000, ease });
  }, [
    target,
    cornerRadius,
    placed,
    reduced,
    baseX,
    baseY,
    baseWidth,
    baseHeight,
    shiftX,
    shiftY,
    shiftWidth,
    shiftHeight,
    radius,
  ]);

  return { x, y, width, height, radius, placed, element };
}

export function Omnibox() {
  const mode = useOmniboxMode();
  const windowInfo = useWindowInfo();
  const phoneLike = isPhoneLike(windowInfo);
  const keyboardInset = useAtomValue(keyboardInsetAtom);
  const { compact } = windowInfo;
  const metrics = omniboxMetrics(compact);
  const reduced = useReducedMotionPref();
  const controller = useOmniboxController();
  const user = useSessionUser();
  const role = roleOf(user);
  const balanceOpen = featuresOf(user).balance;
  const features = useMemo(() => ({ balance: balanceOpen }), [balanceOpen]);

  const store = useStore();
  const [startDraft, setStartDraft] = useAtom(startDraftAtom);
  const [editDraft, setEditDraft] = useAtom(editDraftAtom);
  const [scope, setScope] = useAtom(scopeAtom);
  const scopeFacts = useActivityFacts(scope?.id ?? null);
  const [message, setMessage] = useAtom(messageAtom);
  const pending = useAtomValue(pendingAtom);
  const unconfirmed = useAtomValue(unconfirmedAtom);
  const mismatch = useAtomValue(mismatchAtom);
  const history = useRecentInputs(user?.id ?? null);
  const recent = history.entries;
  const [confirmClear, setConfirmClear] = useState(false);
  // The count asked about, kept while the dialog fades out after clearing.
  const [clearCount, setClearCount] = useState(0);
  // Cleared, the 清空 button leaves with the list: focus goes back to typing.
  const cleared = useRef(false);
  const startLines = useAtomValue(startLinesAtom);
  const editLines = useAtomValue(editLinesAtom);
  const hintTarget = useAtomValue(startHintElementAtom);
  const cooldown = useCooldownSeconds();
  const [focused, setFocused] = useState(false);
  // The value before an IME started composing; null while not composing.
  const [composeBase, setComposeBase] = useState<string | null>(null);

  const expanded = mode === "expanded";
  const docked = mode === "docked";
  // Docked in the 顶栏 over a page that bleeds (the red 红包 cover): the
  // address becomes a light pill so it stays legible on the colour.
  const edge = useAtomValue(viewEdgeAtom);
  const overColor = edge.bleed && docked;
  const liveValue = expanded ? editDraft : startDraft;
  // While fading out into the address, keep showing what was typed.
  const frozen = useRef(liveValue);
  if (!docked) frozen.current = liveValue;
  const value = docked ? frozen.current : liveValue;
  const setValue = expanded ? setEditDraft : setStartDraft;
  const lines = expanded ? editLines : startLines;

  const pathname = useLocation({ select: (location) => location.pathname });
  const overlayPanel = useLocation({
    select: (location) => Boolean(location.state.panel),
  });
  // A page dialog counts as a panel: the shortcuts wait until it closes.
  const cardOpen = useAtomValue(windowDialogsAtom) > 0 || overlayPanel;
  const currentActivityId = useCurrentActivityId();
  const offered = useScopeOffer(currentActivityId);
  const offerId = offered?.id ?? null;
  const offerPurpose = offered?.purpose ?? null;
  const offerHidden = offered?.purpose === "verify" ? offered.hidden : 0;
  const offer = useMemo<ScopeOffer>(
    () =>
      offerId === null || offerPurpose === null
        ? null
        : offerPurpose === "verify"
          ? { id: offerId, purpose: "verify", hidden: offerHidden }
          : { id: offerId, purpose: offerPurpose },
    [offerId, offerPurpose, offerHidden],
  );
  // ⌘K on a 红包 page claims into it (or submits to its code). Verifying is
  // offered as the list's first row (and from the 口令区), not opened
  // straight away.
  const defaultScope = useMemo<Scope>(
    () =>
      offerId !== null && offerPurpose !== null && offerPurpose !== "verify"
        ? { id: offerId, purpose: offerPurpose }
        : null,
    [offerId, offerPurpose],
  );

  const detected = useMemo(
    () => detectScheme(value, window.location.origin),
    [value],
  );
  // A box scoped to one 红包 only takes its 口令. Input that reads as a link
  // or a command is explained rather than acted on (or "optimised").
  const scoped = expanded && scope !== null;
  // 代码判定: whatever is typed goes as it is, links and commands too, with
  // no 口令 rules and no 优化 (02 §4).
  const codeScope = scoped && scope?.purpose === "code";
  const offScope =
    scoped &&
    !codeScope &&
    detected.kind !== "empty" &&
    (detected.kind !== "password" || looksLikeAddress(value));
  // Empty and free, the box says in turn what it takes (02 §6).
  const idleHint = useIdleHint(!docked && !scoped && value === "");
  const scheme = useMemo<EntryScheme>(
    () =>
      codeScope
        ? { kind: "empty" }
        : offScope
          ? { kind: "password", ...inspectPassword(value) }
          : detected,
    [codeScope, offScope, detected, value],
  );
  const commandMode = scheme.kind === "command";
  // While an IME composes, a 口令 holds unconfirmed pinyin and separators.
  // Judge it as it was before composing began, so the rules line, the red
  // marks and the optimise row do not flicker with every keystroke. Commands
  // stay live: their matching already ignores pinyin separators.
  const judging = composeBase !== null && scheme.kind === "password";
  const judgedValue = judging ? composeBase : value;
  const judgedScheme = useMemo(
    () =>
      judgedValue === value
        ? scheme
        : detectScheme(judgedValue, window.location.origin),
    [judgedValue, value, scheme],
  );
  const optimized = offScope ? null : optimizeTarget(judgedValue, judgedScheme);
  // Focus events can lag when the window itself is not focused; the live
  // activeElement check keeps the list in step with what was typed.
  const inputFocused =
    focused ||
    (typeof document !== "undefined" &&
      document.activeElement === omniboxElements.input);
  const panelOpen =
    expanded ||
    (mode === "start" && inputFocused && (commandMode || optimized !== null));
  const codeTyped = codeScope && value.trim() !== "";
  // 代码判定 lists no rows: its record shows under the box instead (02 §4),
  // and what is typed goes to its code as if 领取「标题」 were chosen.
  const codeClaim = useMemo<Suggestion | null>(
    () =>
      codeTyped && scope
        ? { key: "claim", kind: "claim", activityId: scope.id }
        : null,
    [codeTyped, scope],
  );
  const suggestions = useMemo<Suggestion[]>(
    () =>
      codeScope
        ? []
        : panelOpen
          ? buildSuggestions(
              judgedValue,
              judgedScheme,
              scope,
              recent,
              role,
              features,
              optimized,
              expanded && scope === null ? offer : null,
            )
          : [],
    [
      codeScope,
      panelOpen,
      judgedValue,
      judgedScheme,
      scope,
      recent,
      role,
      features,
      optimized,
      expanded,
      offer,
    ],
  );
  // The highlighted row resets whenever the results or the scope change.
  const listKey = `${suggestions.map((item) => item.key).join("|")}:${
    scope ? `${scope.purpose}:${scope.id}` : ""
  }`;
  const [highlight, setHighlight] = useState({ key: listKey, index: 0 });
  const active = highlight.key === listKey ? highlight.index : 0;
  const setActive = useCallback(
    (index: number) => setHighlight({ key: listKey, index }),
    [listKey],
  );

  const chrome: Chrome = mode === "docked" ? "docked-top" : mode;
  const slotName = mode === "start" ? "start" : expanded ? "command" : "dock";
  const target = useSlotRect(slotName);
  const geometry = useSlotGeometry(target, mode, chromeRadius(chrome, compact));

  // Waiting on the same request again, each only in its own place: a
  // lookup (再次确认) in the plain box, a claim (重试原提交) in the box
  // scoped to its 红包.
  const waiting = scope
    ? scope.purpose !== "verify"
      ? unconfirmed.claims[scope.id]
      : undefined
    : unconfirmed.lookup;
  const locked = Boolean(waiting && value !== "" && waiting.password === value);
  // Every 口令红包 counts what is typed on its page (05 §10): the box says
  // so before anything is typed in it, claiming or verifying.
  const statisticsNote =
    expanded && scope && scopeFacts?.password
      ? ({
          tone: "neutral",
          text: "输入的口令会匿名汇总给红包作者。",
        } as const)
      : null;
  // A share text pasted whole (02 §6): its 口令 goes in once the 红包 opens.
  const pasted = useAtomValue(pastedPasswordAtom);
  const pastedNote =
    pasted &&
    !scoped &&
    "activityId" in scheme &&
    scheme.activityId === pasted.activityId
      ? ({ tone: "neutral", text: "已识别口令，打开红包后自动提交。" } as const)
      : null;
  const ownMessage =
    message?.activityId && message.activityId !== scope?.id ? null : message;
  const typed = Array.from(value.trim()).length;
  // 代码判定 joins pasted lines (02 §4): said while what went in for them
  // is still in the box.
  const [joined, setJoined] = useState<string | null>(null);
  const linesJoined = codeScope && joined !== null && value.includes(joined);
  const shownMessage = codeScope
    ? (ownMessage ?? {
        tone: /[\r\n]/.test(value) || typed > 200 ? "warning" : "neutral",
        text: `${linesJoined ? "粘贴的换行已换成空格" : "原样提交：区分大小写，符号都算，首尾空格会去掉"} · ${typed} / 200`,
      })
    : offScope
      ? ({
          tone: "warning",
          text: "这里只能输入口令；清空后按退格，可改为输入链接或命令。",
        } as const)
      : commandMode
        ? null
        : (resolveMessage(
            judgedValue,
            judgedScheme,
            // A claim's answer belongs in the box scoped to its 红包 (or on
            // that page), not wherever the box is when it arrives.
            ownMessage,
          ) ??
          pastedNote ??
          statisticsNote);

  // The bar keeps its last address while fading out, and rolls to a new one
  // only if it was already showing an address (not while fading in).
  const liveAddress = useAddress(compact);
  const lastAddress = useRef(liveAddress);
  if (docked) lastAddress.current = liveAddress;
  const address = docked ? liveAddress : lastAddress.current;

  // Leaving a mode resets transient state; focus follows the visible control:
  // closing the box returns to the bar, arriving somewhere new goes to the view.
  const previousMode = useRef(mode);
  const previousPath = useRef(pathname);
  const latest = useRef({ editDraft, phoneLike });
  latest.current = { editDraft, phoneLike };
  const rollAddress = docked && previousMode.current === "docked" && !reduced;
  useEffect(() => {
    const previous = previousMode.current;
    const moved = previousPath.current !== pathname;
    previousMode.current = mode;
    previousPath.current = pathname;
    if (previous === mode) return;
    setMessage(null);
    if (previous === "expanded") {
      // Back from the search mode: the text stays in the start page's box,
      // and the keyboard goes away.
      if (mode === "start") {
        setStartDraft(latest.current.editDraft);
        if (latest.current.phoneLike) omniboxElements.input?.blur();
      }
      setEditDraft("");
      setScope(null);
    }
    const input = omniboxElements.input;
    const inputFocused = input !== null && document.activeElement === input;
    if (
      mode === "docked" &&
      (inputFocused || document.activeElement === document.body)
    ) {
      if (previous === "expanded" && !moved)
        omniboxElements.address?.focus({ preventScroll: true });
      else document.getElementById("view")?.focus({ preventScroll: true });
    }
    // On a phone, focus would open the search mode: wait for a tap.
    if (
      mode === "start" &&
      matchMedia("(pointer: fine)").matches &&
      !latest.current.phoneLike
    )
      focusOmniboxInput();
  }, [mode, pathname, setEditDraft, setMessage, setScope, setStartDraft]);

  // ⌘K / Ctrl+K toggles the box; "/" outside text fields starts a command.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || cardOpen) return;
      if (isOpenShortcut(event)) {
        event.preventDefault();
        if (mode === "start") focusOmniboxInput(true);
        else if (mode === "docked") controller.expand(defaultScope);
        else controller.collapse();
        return;
      }
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableTarget(event.target)
      )
        return;
      event.preventDefault();
      if (mode === "start") {
        if (startDraft) focusOmniboxInput(true);
        else {
          setStartDraft("/");
          focusOmniboxInput();
        }
      } else if (mode === "docked") controller.expand(null, "/");
      else focusOmniboxInput();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cardOpen, controller, defaultScope, mode, setStartDraft, startDraft]);

  const runSuggestion = useCallback(
    (item: Suggestion) => {
      if (item.kind === "optimize") {
        setValue(item.value);
        setMessage(null);
        focusOmniboxInput();
        return;
      }
      if (item.kind === "command") {
        void controller.runCommand(item.command);
        return;
      }
      if (item.kind === "recent") {
        setEditDraft(item.entry.password);
        setMessage(null);
        focusOmniboxInput();
        return;
      }
      // This 红包's row: type into it from here on.
      if (item.kind === "scope") {
        setScope({ id: item.activityId, purpose: item.purpose });
        setMessage(null);
        focusOmniboxInput();
        return;
      }
      if (item.kind === "claim") {
        void controller.redeemIn(item.activityId, value, {
          code: scope?.purpose === "code",
        });
        return;
      }
      if (item.kind === "verify") {
        void controller.verifyIn(item.activityId, value);
        return;
      }
      if (item.kind === "discover") setScope(null);
      void controller.submit(value, true);
    },
    [controller, scope, setEditDraft, setMessage, setScope, setValue, value],
  );

  const execute = useCallback(() => {
    if (pending) return;
    if (codeClaim) {
      runSuggestion(codeClaim);
      return;
    }
    if (panelOpen) {
      const item = suggestions[active] ?? suggestions[0];
      if (item) runSuggestion(item);
      return;
    }
    void controller.submit(value, false);
  }, [
    active,
    codeClaim,
    controller,
    panelOpen,
    pending,
    runSuggestion,
    suggestions,
    value,
  ]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (expanded) controller.collapse();
        else if (value && !locked) {
          setValue("");
          setMessage(null);
        } else event.currentTarget.blur();
        return true;
      }
      // Shift+Delete drops the highlighted 最近输入 (as browsers do).
      if (
        event.key === "Delete" &&
        event.shiftKey &&
        panelOpen &&
        suggestions[active]?.kind === "recent"
      ) {
        event.preventDefault();
        const item = suggestions[active];
        if (item?.kind === "recent") history.remove(item.entry.password);
        return true;
      }
      if (event.key === "Backspace" && expanded && scope && value === "") {
        event.preventDefault();
        setScope(null);
        return true;
      }
      if (
        panelOpen &&
        suggestions.length > 0 &&
        (event.key === "ArrowDown" || event.key === "ArrowUp")
      ) {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((active + step + suggestions.length) % suggestions.length);
        return true;
      }
      if (event.key === "Tab" && !event.shiftKey) {
        const item = suggestions[active];
        // Tab applies the optimise row, like Enter.
        if (item?.kind === "optimize") {
          event.preventDefault();
          runSuggestion(item);
          return true;
        }
        // Complete the highlighted command (also turns "、" into "/").
        if (commandMode && item?.kind === "command") {
          const completed = `/${item.command.name}`;
          if (value !== completed) {
            event.preventDefault();
            setValue(completed);
            return true;
          }
        }
      }
      return false;
    },
    [
      active,
      commandMode,
      controller,
      expanded,
      locked,
      panelOpen,
      history.remove,
      runSuggestion,
      scope,
      setActive,
      setMessage,
      setScope,
      setValue,
      suggestions,
      value,
    ],
  );

  const activeItem =
    codeClaim ?? (panelOpen ? (suggestions[active] ?? suggestions[0]) : null);
  const usesCooldown =
    (scheme.kind === "password" || codeScope) &&
    activeItem?.kind !== "optimize" &&
    (!expanded ||
      activeItem?.kind === "claim" ||
      activeItem?.kind === "verify" ||
      activeItem?.kind === "discover");
  // A timed draw is joined, not claimed (05 §1).
  // The row that sends a waiting request again: a lookup row the lookup
  // (再次确认), any other row this 红包's claim (重试原提交).
  const retryRow =
    activeItem?.kind === "discover"
      ? unconfirmed.lookup?.password === value
      : locked;
  const claimTarget =
    activeItem?.kind === "claim" ? activeItem.activityId : scope?.id;
  const claimFacts = useActivityFacts(claimTarget ?? null);
  const claimVerb = claimFacts?.timedDraw ? "报名" : "领取";
  const actionLabel = pending ? (
    codeScope ? (
      "正在判定…"
    ) : (
      "正在确认…"
    )
  ) : activeItem?.kind === "optimize" ? (
    "优化"
  ) : commandMode ? (
    activeItem?.kind === "command" && activeItem.gate ? (
      "登录"
    ) : (
      "前往"
    )
  ) : retryRow ? (
    (activeItem ? activeItem.kind === "claim" : scope !== null) ? (
      "重试原提交"
    ) : (
      "再次确认"
    )
  ) : usesCooldown && cooldown > 0 ? (
    // One piece whose number rolls, not a new label each second.
    <>
      还需等待 <RollingNumber value={cooldown} /> 秒
    </>
  ) : activeItem?.kind === "verify" ? (
    "验证"
  ) : activeItem?.kind === "claim" || scheme.kind === "password" ? (
    claimVerb
  ) : isJumpScheme(scheme) || scheme.kind === "topic" ? (
    "打开红包"
  ) : (
    ""
  );
  const showAction =
    // 代码判定 judging: the box is emptied into its card, the button stays
    // to say 正在判定… (02 §4).
    (pending && codeScope) ||
    (value.length > 0 &&
      !(panelOpen && activeItem?.kind === "recent") &&
      !(commandMode && !activeItem) &&
      // An expanded box with nothing to run (a 口令 that cannot be fixed).
      !(expanded && scheme.kind === "password" && !activeItem));
  const actionDisabled = pending || (usesCooldown && cooldown > 0 && !retryRow);

  const actionSize = compact ? "bar" : "md";
  const actionRadius = buttonRadius[actionSize];
  const actionShape = useButtonShape(actionRadius, buttonHeight[actionSize]);
  const scopeActivity = expanded && scope && !commandMode ? scopeFacts : null;
  // The list stops above the on-screen keyboard.
  const panelMaxHeight = target
    ? Math.max(
        160,
        windowInfo.height - keyboardInset - (target.y + target.height) - 20,
      )
    : undefined;

  return (
    <motion.div
      ref={geometry.element}
      className="absolute top-0 left-0 z-30"
      style={{
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height,
        visibility: geometry.placed ? "visible" : "hidden",
      }}
      data-omnibox-mode={mode}
    >
      {/* Drop shadows and the focus glow; the squircle clip would cut them. */}
      <SquirclePlate
        className="omnibox-plate"
        data-chrome={chrome}
        data-bleed={overColor || undefined}
        data-lacquer={(overColor && edge.lacquer) || undefined}
        data-focus={!docked && inputFocused ? "" : undefined}
        radius={geometry.radius}
      />
      <Squircle radius={geometry.radius}>
        <search
          className="omnibox-chrome group relative h-full w-full"
          data-chrome={chrome}
          data-bleed={overColor || undefined}
          data-compact={compact || undefined}
        >
          {/* Edit layer: start page and the expanded command box. */}
          <motion.div
            className="absolute inset-0 flex items-center gap-2 pr-2 pl-2.5"
            initial={false}
            animate={{ opacity: docked ? 0 : 1 }}
            transition={{
              duration: reduced ? 0 : docked ? durations.exit : 0.2,
              delay: reduced || docked ? 0 : 0.1,
            }}
            style={{ pointerEvents: docked ? "none" : "auto" }}
            aria-hidden={docked || undefined}
          >
            <AnimatePresence initial={false} mode="popLayout">
              {scopeActivity ? (
                <ScopeChip
                  key="scope"
                  title={scopeActivity.title}
                  purpose={scope?.purpose ?? "claim"}
                  compact={compact}
                  onRemove={() => {
                    setScope(null);
                    focusOmniboxInput();
                  }}
                />
              ) : (
                <SchemeChip
                  key="scheme"
                  scheme={scheme}
                  idle={idleHint?.kind}
                  compact={compact}
                />
              )}
            </AnimatePresence>
            <OmniboxField
              value={value}
              onChange={(next) => {
                setValue(next);
                if (message) setMessage(null);
                store.set(pastedPasswordAtom, null);
              }}
              joinLines={codeScope}
              onLinesJoined={setJoined}
              onPaste={(text) => {
                // 代码判定 takes what is pasted as it is, its lines joined
                // (the field does that).
                if (codeScope) return false;
                // A share text pasted whole (02 §6): its 红包's address in
                // the box (its 口令 kept for when it opens), or the 口令 alone.
                const shared = readShareText(text);
                if (!shared) return false;
                if (scoped) {
                  // In a 红包's box only its own 口令 goes in.
                  if (
                    !shared.password ||
                    (shared.activityId && shared.activityId !== scope?.id)
                  )
                    return false;
                  setValue(shared.password);
                } else if (shared.activityId) {
                  setValue(activityPath(shared.activityId));
                  store.set(
                    pastedPasswordAtom,
                    shared.password
                      ? {
                          activityId: shared.activityId,
                          password: shared.password,
                        }
                      : null,
                  );
                  if (message) setMessage(null);
                  return true;
                } else if (shared.password) setValue(shared.password);
                if (message) setMessage(null);
                store.set(pastedPasswordAtom, null);
                return true;
              }}
              onEnter={execute}
              onKeyDown={onKeyDown}
              markInvalid={
                scheme.kind === "password" &&
                !offScope &&
                !looksLikeAddress(value) &&
                composeBase === null
              }
              command={commandMode}
              lines={lines}
              lineHeight={metrics.line}
              compact={compact}
              readOnly={locked || pending}
              inactive={docked}
              mono={codeScope}
              placeholder={
                codeScope
                  ? scopeFacts?.code?.prompt || "输入要提交的内容"
                  : scope?.purpose === "verify" && scoped
                    ? "输入其他口令"
                    : scoped
                      ? "输入口令"
                      : compact
                        ? "口令、红包链接或 / 命令"
                        : "输入口令、红包链接，或输入 / 使用命令"
              }
              hint={
                idleHint && <IdleHintText hint={idleHint} compact={compact} />
              }
              ariaLabel="口令、红包链接或命令"
              onFocusChange={(next) => {
                setFocused(next);
                // Phones: the start page's box opens as the command box at
                // the top (search mode), so the list has room above the
                // keyboard; what was typed comes along. Read from the store:
                // a tap that fills the box and focuses it (全部命令's "/", a
                // 最近输入) lands here before this render has seen it.
                if (next && mode === "start" && phoneLike)
                  controller.expand(null, store.get(startDraftAtom));
              }}
              onCompositionChange={(composing) =>
                setComposeBase(composing ? value : null)
              }
              listbox={
                panelOpen && suggestions.length > 0
                  ? { id: LISTBOX_ID, active }
                  : null
              }
              mismatch={mismatch}
            />
            <AnimatePresence initial={false}>
              {value.length > 0 && !locked && (
                <motion.button
                  key="clear"
                  type="button"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setValue("");
                    setMessage(null);
                    focusOmniboxInput();
                  }}
                  aria-label="清空输入"
                  title="清空输入"
                  className="grid size-9 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-fill-2 hover:text-ink-2"
                >
                  <X className="size-[18px]" aria-hidden="true" />
                </motion.button>
              )}
            </AnimatePresence>
            <AnimatePresence initial={false}>
              {showAction && (
                // Comes and goes on its own layer: the button's transform is
                // left to the press (.btn transitions it).
                <motion.span
                  key="action"
                  className="flex shrink-0"
                  initial={{ opacity: 0, x: 6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 6 }}
                  transition={{ duration: 0.16 }}
                >
                  <button
                    type="button"
                    disabled={actionDisabled}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={execute}
                    className={buttonVariants({
                      // 代码判定: lacquer, as its scope chip (05 §14).
                      variant: codeScope ? "lacquer" : "primary",
                      size: actionSize,
                    })}
                    style={actionShape}
                  >
                    <SquircleFill radius={actionRadius} />
                    <MorphLabel>
                      {pending && <Spinner />}
                      {actionLabel}
                    </MorphLabel>
                  </button>
                </motion.span>
              )}
            </AnimatePresence>
          </motion.div>

          {/* Address layer: the docked, display-only state. */}
          <motion.button
            ref={(element) => {
              omniboxElements.address = element;
            }}
            type="button"
            tabIndex={docked ? 0 : -1}
            aria-hidden={!docked || undefined}
            aria-label={address.label || undefined}
            onClick={() => controller.expand(defaultScope)}
            className="absolute inset-0 flex items-center gap-3 overflow-hidden rounded-[inherit] px-3 [corner-shape:inherit] text-left text-base transition-colors hover:bg-white/40"
            initial={false}
            animate={{ opacity: docked ? 1 : 0 }}
            transition={{
              duration: reduced ? 0 : docked ? 0.2 : durations.exit,
              delay: reduced || !docked ? 0 : 0.14,
            }}
            style={{ pointerEvents: docked ? "auto" : "none" }}
          >
            <AddressRoller
              address={address}
              roll={rollAddress}
              depth={metrics.docked / 2}
            />
            {!compact && <ShortcutKbd className="shrink-0" />}
          </motion.button>
        </search>
      </Squircle>

      {/* Start page: the message line lives in the page's own flow. With
          no list there, a valid 口令's length stays where the rules had it. */}
      {mode === "start" &&
        hintTarget &&
        !panelOpen &&
        createPortal(
          <MessageLine
            message={shownMessage}
            count={
              judgedScheme.kind === "password" && judgedScheme.valid
                ? judgedScheme.length
                : null
            }
            onAction={controller.runMessageAction}
          />,
          hintTarget,
        )}

      <AnimatePresence>
        {panelOpen && (
          <SuggestionPanel
            key="panel"
            id={LISTBOX_ID}
            items={suggestions}
            active={active}
            onHover={setActive}
            onRun={runSuggestion}
            maxHeight={panelMaxHeight}
            message={
              shownMessage ? (
                <MessageLine
                  message={shownMessage}
                  onAction={controller.runMessageAction}
                />
              ) : undefined
            }
            body={
              codeScope && scope ? (
                <JudgmentRecord activityId={scope.id} />
              ) : undefined
            }
            empty={
              // 代码判定: its message line says what to type.
              codeScope ? null : (
                <p className="px-3 py-3 text-sm text-ink-3">
                  {commandMode
                    ? "没有匹配的命令 · 输入 / 查看全部"
                    : "输入口令、红包链接，或输入 / 使用命令"}
                </p>
              )
            }
            footer={
              suggestions.some((item) => item.kind === "recent") ? (
                <div className="flex items-center gap-2 px-3 pt-1 pb-0.5">
                  <p className="min-w-0 flex-1 text-xs text-ink-3">
                    最近输入只存在这个浏览器里
                    {!compact && " · Shift+Delete 删除选中的一条"}
                  </p>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="-my-1"
                    onClick={() => {
                      setClearCount(recent.length);
                      setConfirmClear(true);
                    }}
                  >
                    清空
                  </Button>
                </div>
              ) : commandMode && suggestions.length > 0 && !compact ? (
                <p className="px-3 pt-1.5 pb-1 text-xs text-ink-3">
                  ↑↓ 选择 · Tab 补全 · ↵ 前往
                </p>
              ) : null
            }
          />
        )}
      </AnimatePresence>
      {/* One lasting region says every result (未匹配到红包, 口令不正确…),
          wherever it is shown; the lines that show them are not live. */}
      <p role="status" className="sr-only">
        {message?.text ?? ""}
      </p>
      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onClosed={() => {
          if (cleared.current) focusOmniboxInput();
          cleared.current = false;
        }}
        title="清空最近输入？"
        text={`这个浏览器里记下的 ${clearCount} 条口令会全部删除，不能恢复。不影响已经领到的红包。`}
        actions={
          <>
            <Button onClick={() => setConfirmClear(false)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                cleared.current = true;
                history.clear();
                setConfirmClear(false);
              }}
            >
              清空
            </Button>
          </>
        }
      />
    </motion.div>
  );
}
