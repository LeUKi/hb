import { atom, useAtomValue, useSetAtom } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { simKeyboardAtom } from "../../lib/store";
import { isPhoneLike, useWindowInfo } from "./window-info";

/**
 * How much of the window's bottom the on-screen keyboard covers, in px:
 * the real one (measured with visualViewport), or the dev toolbar's
 * simulated one. Lists that open under the 指令框 stop above it.
 */
export const keyboardInsetAtom = atom(0);

function isTextField(element: Element | null) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable || element instanceof HTMLTextAreaElement)
    return true;
  return (
    element instanceof HTMLInputElement &&
    !["button", "checkbox", "radio", "range", "submit", "reset"].includes(
      element.type,
    )
  );
}

/** Whether a text field inside the window has focus (a keyboard would be up). */
function useTyping() {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const update = () => {
      const active = document.activeElement;
      setTyping(
        isTextField(active) && Boolean(active?.closest("[data-window-layer]")),
      );
    };
    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, []);
  return typing;
}

/** The real keyboard: what the visual viewport leaves of the window's bottom. */
function useViewportInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const layer = document.querySelector("[data-window-layer]");
      if (!layer) return;
      const bottom = layer.getBoundingClientRect().bottom;
      setInset(
        Math.max(
          0,
          Math.round(bottom - (viewport.offsetTop + viewport.height)),
        ),
      );
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

// Key names only name the blank keys; the simulation draws no letters.
const rows = [
  [..."qwertyuiop"],
  [..."asdfghjkl"],
  ["shift", ..."zxcvbnm", "delete"],
  ["123", "emoji", "space", "period", "go"],
];

/**
 * Keeps keyboardInsetAtom current, and draws the simulated keyboard (dev
 * toolbar 模拟手机键盘) over the window's bottom while a text field has
 * focus in a phone-sized window — a stand-in for the system keyboard,
 * which desktop browsers never show. It never takes focus.
 */
export function KeyboardLayer() {
  const info = useWindowInfo();
  const simulate = useAtomValue(simKeyboardAtom);
  const typing = useTyping();
  const real = useViewportInset();
  const setInset = useSetAtom(keyboardInsetAtom);
  const shown = simulate && typing && isPhoneLike(info);
  const height = Math.round(Math.min(336, info.height * 0.45));
  const inset = shown ? height : real;
  useEffect(() => setInset(inset), [inset, setInset]);

  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          key="keyboard"
          aria-hidden="true"
          className="sim-keyboard absolute inset-x-0 bottom-0 z-[60] grid content-start gap-2.5 px-1 pt-2"
          style={{ height }}
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
          onPointerDown={(event) => event.preventDefault()}
        >
          <p className="px-2 text-[11px] text-ink-3">模拟键盘</p>
          {rows.map((keys) => (
            <div key={keys[0]} className="flex justify-center gap-1.5 px-1">
              {keys.map((name) => (
                <span
                  key={name}
                  className={`sim-key h-10 ${name === "space" ? "flex-[5]" : "flex-1"}`}
                />
              ))}
            </div>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
