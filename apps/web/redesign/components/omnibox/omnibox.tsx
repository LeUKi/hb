import { useLocation } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { X } from "lucide-react";
import {
  AnimatePresence,
  type AnimationPlaybackControls,
  animate,
  motion,
  useMotionValue,
} from "motion/react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { findActivity } from "../../fixtures/activities";
import { useCurrentActivityId } from "../../lib/activity-route";
import { roleOf } from "../../lib/commands";
import { durations, ease, useReducedMotionPref } from "../../lib/motion";
import { inspectPassword } from "../../lib/password-rules";
import { isOpenShortcut } from "../../lib/platform";
import {
  detectScheme,
  type EntryScheme,
  isJumpScheme,
  looksLikeAddress,
} from "../../lib/scheme";
import {
  clearRecentAtom,
  recentAtom,
  removeRecentAtom,
  sessionAtom,
  viewEdgeAtom,
  windowDialogsAtom,
} from "../../lib/store";
import { keyboardInsetAtom } from "../shell/keyboard";
import { type SlotRect, useSlotRect } from "../shell/slots";
import { WindowDialog } from "../shell/window-dialog";
import { isPhoneLike, useWindowInfo } from "../shell/window-info";
import { Button, useButtonShape } from "../ui/button";
import { ShortcutKbd, Spinner } from "../ui/kbd";
import { MorphLabel, RollingNumber } from "../ui/morph-label";
import { Squircle, SquircleFill, SquirclePlate } from "../ui/squircle";
import { AddressRoller, useAddress } from "./address";
import { SchemeChip, ScopeChip } from "./chips";
import { OmniboxField } from "./field";
import { MessageLine, resolveMessage } from "./message";
import {
  editDraftAtom,
  editLinesAtom,
  messageAtom,
  mismatchAtom,
  omniboxMetrics,
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
 */
function useSlotGeometry(
  target: SlotRect | undefined,
  modeKey: string,
  cornerRadius: number,
) {
  const reduced = useReducedMotionPref();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const width = useMotionValue(0);
  const height = useMotionValue(0);
  const radius = useMotionValue(cornerRadius);
  const [placed, setPlaced] = useState(false);
  const pending = useRef(false);
  const lastKey = useRef(modeKey);
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
    if (!target) return;
    const pairs = [
      [x, target.x],
      [y, target.y],
      [width, target.width],
      [height, target.height],
      [radius, cornerRadius],
    ] as const;
    const stop = () => {
      for (const control of flight.current?.controls ?? []) control.stop();
      flight.current = null;
    };
    const fly = (seconds: number) => {
      for (const control of flight.current?.controls ?? []) control.stop();
      flight.current = {
        until: performance.now() + seconds * 1000,
        controls: pairs.map(([value, to]) =>
          animate(value, to, { duration: seconds, ease }),
        ),
      };
    };
    if (!placed || reduced) {
      stop();
      for (const [value, to] of pairs) value.jump(to);
      pending.current = false;
      if (!placed) setPlaced(true);
      return;
    }
    if (pending.current) {
      pending.current = false;
      fly(durations.travel);
      return;
    }
    const now = performance.now();
    if (flight.current && now < flight.current.until) {
      // Slot moved mid-flight: retarget with the remaining time.
      fly(Math.max(0.08, (flight.current.until - now) / 1000));
      return;
    }
    stop();
    for (const [value, to] of pairs) value.jump(to);
  }, [target, cornerRadius, placed, reduced, x, y, width, height, radius]);

  return { x, y, width, height, radius, placed };
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
  const role = roleOf(useAtomValue(sessionAtom));

  const [startDraft, setStartDraft] = useAtom(startDraftAtom);
  const [editDraft, setEditDraft] = useAtom(editDraftAtom);
  const [scope, setScope] = useAtom(scopeAtom);
  const [message, setMessage] = useAtom(messageAtom);
  const pending = useAtomValue(pendingAtom);
  const unconfirmed = useAtomValue(unconfirmedAtom);
  const mismatch = useAtomValue(mismatchAtom);
  const recent = useAtomValue(recentAtom);
  const removeRecent = useSetAtom(removeRecentAtom);
  const clearRecent = useSetAtom(clearRecentAtom);
  const [confirmClear, setConfirmClear] = useState(false);
  // The count asked about, kept while the dialog fades out after clearing.
  const [clearCount, setClearCount] = useState(0);
  // Cleared, the 清空 button leaves with the list: focus goes back to typing.
  const cleared = useRef(false);
  const clearTitle = useId();
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
  const overColor = useAtomValue(viewEdgeAtom).bleed && docked;
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
        : offerPurpose === "claim"
          ? { id: offerId, purpose: "claim" }
          : { id: offerId, purpose: "verify", hidden: offerHidden },
    [offerId, offerPurpose, offerHidden],
  );
  // ⌘K on a 红包 page claims into it. Verifying is offered as the list's
  // first row (and from the 口令区), not opened straight away.
  const defaultScope = useMemo<Scope>(
    () =>
      offerId !== null && offerPurpose === "claim"
        ? { id: offerId, purpose: "claim" }
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
  const offScope =
    scoped &&
    detected.kind !== "empty" &&
    (detected.kind !== "password" || looksLikeAddress(value));
  const scheme = useMemo<EntryScheme>(
    () =>
      offScope ? { kind: "password", ...inspectPassword(value) } : detected,
    [offScope, detected, value],
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
  const suggestions = useMemo(
    () =>
      panelOpen
        ? buildSuggestions(
            judgedValue,
            judgedScheme,
            scope,
            recent,
            role,
            optimized,
            expanded && scope === null ? offer : null,
          )
        : [],
    [
      panelOpen,
      judgedValue,
      judgedScheme,
      scope,
      recent,
      role,
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
    ? scope.purpose === "claim"
      ? unconfirmed.claims[scope.id]
      : undefined
    : unconfirmed.lookup;
  const locked = Boolean(waiting && value !== "" && waiting.password === value);
  // A 红包 that counts attempts says so before anything is typed in it
  // (production's notice): what is submitted is summed up for its sender.
  const statisticsNote =
    expanded && scope?.purpose === "claim" && findActivity(scope.id)?.statistics
      ? ({
          tone: "neutral",
          text: "这个红包开了尝试统计：提交的口令会汇总给发红包的人看。",
        } as const)
      : null;
  const shownMessage = offScope
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
          message?.activityId && message.activityId !== scope?.id
            ? null
            : message,
        ) ?? statisticsNote);

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
        void controller.redeemIn(item.activityId, value);
        return;
      }
      if (item.kind === "verify") {
        void controller.verifyIn(item.activityId, value);
        return;
      }
      if (item.kind === "discover") setScope(null);
      void controller.submit(value, true);
    },
    [controller, setEditDraft, setMessage, setScope, setValue, value],
  );

  const execute = useCallback(() => {
    if (pending) return;
    if (panelOpen) {
      const item = suggestions[active] ?? suggestions[0];
      if (item) runSuggestion(item);
      return;
    }
    void controller.submit(value, false);
  }, [
    active,
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
        if (item?.kind === "recent") removeRecent(item.entry.password);
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
      removeRecent,
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

  const activeItem = panelOpen ? (suggestions[active] ?? suggestions[0]) : null;
  const usesCooldown =
    scheme.kind === "password" &&
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
  const claimVerb =
    claimTarget && findActivity(claimTarget)?.mode === "timed_draw"
      ? "报名"
      : "领取";
  const actionLabel = pending ? (
    "正在确认…"
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
    value.length > 0 &&
    !(panelOpen && activeItem?.kind === "recent") &&
    !(commandMode && !activeItem) &&
    // An expanded box with nothing to run (a 口令 that cannot be fixed).
    !(expanded && scheme.kind === "password" && !activeItem);
  const actionDisabled = pending || (usesCooldown && cooldown > 0 && !retryRow);

  const actionRadius = compact ? 13 : 14;
  const actionShape = useButtonShape(actionRadius, compact ? 40 : 44);
  const scopeActivity =
    expanded && scope && !commandMode ? findActivity(scope.id) : null;
  // The list stops above the on-screen keyboard.
  const panelMaxHeight = target
    ? Math.max(
        160,
        windowInfo.height - keyboardInset - (target.y + target.height) - 20,
      )
    : undefined;

  return (
    <motion.div
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
                <SchemeChip key="scheme" scheme={scheme} compact={compact} />
              )}
            </AnimatePresence>
            <OmniboxField
              value={value}
              onChange={(next) => {
                setValue(next);
                if (message) setMessage(null);
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
              placeholder={
                scope?.purpose === "verify" && scoped
                  ? "输入其他口令"
                  : scoped
                    ? "输入口令"
                    : compact
                      ? "口令、红包链接或 / 命令"
                      : "输入口令、红包链接，或输入 / 使用命令"
              }
              ariaLabel="口令、红包地址或命令"
              onFocusChange={(next) => {
                setFocused(next);
                // Phones: the start page's box opens as the command box at
                // the top (search mode), so the list has room above the
                // keyboard; what was typed comes along.
                if (next && mode === "start" && phoneLike)
                  controller.expand(null, startDraft);
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
                    className={`btn btn-primary px-4 ${
                      compact ? "h-10 text-sm" : "h-11 text-base"
                    }`}
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

      {/* Start page: the message line lives in the page's own flow. */}
      {mode === "start" &&
        hintTarget &&
        !panelOpen &&
        createPortal(
          <MessageLine
            message={shownMessage}
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
            empty={
              <p className="px-3 py-3 text-sm text-ink-3">
                {commandMode
                  ? "没有匹配的命令 · 输入 / 查看全部"
                  : "输入口令、红包链接，或输入 / 使用命令"}
              </p>
            }
            footer={
              suggestions.some((item) => item.kind === "recent") ? (
                <div className="flex items-center gap-2 px-3 pt-1 pb-0.5">
                  <p className="min-w-0 flex-1 text-xs text-ink-3">
                    最近输入只存在这个浏览器里
                    {!compact && " · Shift+Delete 删除选中的一条"}
                  </p>
                  <Squircle radius={8}>
                    <button
                      type="button"
                      onClick={() => {
                        setClearCount(recent.length);
                        setConfirmClear(true);
                      }}
                      className="h-7 shrink-0 px-2 text-xs text-ink-2 transition-colors hover:bg-fill-2 hover:text-ink"
                    >
                      清空
                    </button>
                  </Squircle>
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
      <WindowDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onClosed={() => {
          if (cleared.current) focusOmniboxInput();
          cleared.current = false;
        }}
        labelledBy={clearTitle}
      >
        <div className="grid gap-4 p-5">
          <div className="grid gap-1">
            <h2 id={clearTitle} className="text-lg font-semibold text-ink">
              清空最近输入？
            </h2>
            <p className="text-sm text-ink-2">
              这个浏览器里记下的 {clearCount}{" "}
              条口令会全部删除，不能恢复。不影响已经领到的红包。
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => setConfirmClear(false)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                cleared.current = true;
                clearRecent();
                setConfirmClear(false);
              }}
            >
              清空
            </Button>
          </div>
        </div>
      </WindowDialog>
    </motion.div>
  );
}
