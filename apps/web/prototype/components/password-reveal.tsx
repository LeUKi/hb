import { Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "./passwords.css";

export type PasswordRevealProps = {
  text: string;
  label?: string;
  scope: string;
  index?: number;
  pinned?: boolean;
  bulkHideVersion?: number;
  onPinnedChange?: (pinned: boolean) => void;
  defaultRevealed?: boolean;
};

export function PasswordReveal(props: PasswordRevealProps) {
  return (
    <PasswordRevealSession
      key={`${props.scope}\u001f${props.text}\u001f${props.defaultRevealed ?? false}`}
      {...props}
    />
  );
}

function PasswordRevealSession({
  text,
  label,
  pinned = false,
  bulkHideVersion = 0,
  onPinnedChange,
  defaultRevealed = false,
}: PasswordRevealProps) {
  const controlled = typeof onPinnedChange === "function";
  const [localPinned, setLocalPinned] = useState(defaultRevealed);
  const [hovered, setHovered] = useState(false);
  const [suppressHover, setSuppressHover] = useState(false);
  const hoveredRef = useRef(false);
  const previousBulkHideVersion = useRef(bulkHideVersion);
  const effectivePinned = controlled ? pinned : localPinned;

  useEffect(() => {
    if (previousBulkHideVersion.current === bulkHideVersion) return;
    previousBulkHideVersion.current = bulkHideVersion;
    setSuppressHover((current) => current || hoveredRef.current);
  }, [bulkHideVersion]);

  const revealed = effectivePinned || (hovered && !suppressHover);

  return (
    <div
      className={`pw-reveal${revealed ? " pw-reveal--shown" : ""}`}
      data-password-state="known"
    >
      <div className="pw-reveal__body">
        <div
          className="pw-reveal__interaction"
          onPointerEnter={(event) => {
            if (event.pointerType !== "mouse") return;
            hoveredRef.current = true;
            setHovered(true);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== "mouse") return;
            hoveredRef.current = false;
            setHovered(false);
            setSuppressHover(false);
          }}
        >
          <span
            className={`pw-reveal__value${revealed ? "" : " pw-reveal__value--hidden"}`}
            aria-hidden={!revealed}
            draggable={false}
          >
            {text}
          </span>
          <button
            type="button"
            className="pw-reveal__control pw-reveal__eye"
            aria-label={effectivePinned ? "隐藏内容" : "显示内容"}
            aria-pressed={effectivePinned}
            onClick={() => {
              const nextPinned = !effectivePinned;
              setSuppressHover(!nextPinned && hoveredRef.current);
              if (controlled) onPinnedChange?.(nextPinned);
              else setLocalPinned(nextPinned);
            }}
          >
            {revealed ? (
              <EyeOff size={16} aria-hidden="true" />
            ) : (
              <Eye size={16} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      {label && (
        <div className="pw-reveal__heading">
          <span className="pw-reveal__label">{label}</span>
        </div>
      )}
    </div>
  );
}
