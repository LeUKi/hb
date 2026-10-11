import { Eye, EyeOff, LockKeyhole } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { CompactIconButton } from "./compact-icon-button";
import { PasswordReveal } from "./password-reveal";

export type KnownPasswordItem = {
  kind: "known";
  text: string;
  label?: string;
};

export type LockedPasswordItem = {
  kind: "locked";
  hiddenCount: number;
  scope: string;
};

export type PasswordPresentationItem = KnownPasswordItem | LockedPasswordItem;

export type PasswordListProps = {
  known: readonly Omit<KnownPasswordItem, "kind">[];
  hiddenCount: number;
  scope: string;
  heading?: ReactNode;
  defaultRevealed?: boolean;
};

const placeholderAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const lockedPlaceholders = new Map<string, string[]>();

function createPlaceholder() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(
    bytes,
    (byte) => placeholderAlphabet[byte % placeholderAlphabet.length],
  ).join("");
}

function placeholdersFor({
  hiddenCount,
  scope,
}: Omit<LockedPasswordItem, "kind">) {
  const count =
    Number.isSafeInteger(hiddenCount) && hiddenCount > 0 ? hiddenCount : 0;
  let cached = lockedPlaceholders.get(scope);
  if (!cached) {
    cached = [];
    lockedPlaceholders.set(scope, cached);
  }
  while (cached.length < count) cached.push(createPlaceholder());
  return cached.slice(0, count);
}

export function LockedPasswords(props: Omit<LockedPasswordItem, "kind">) {
  return placeholdersFor(props).map((placeholder) => (
    <div
      key={`${props.scope}:${placeholder}`}
      className="pw-locked"
      data-password-state="locked"
    >
      <span className="pw-locked__value" aria-hidden="true">
        {placeholder}
      </span>
      <span className="pw-locked__status">
        <LockKeyhole size={14} aria-hidden="true" />
        <span>未解出</span>
      </span>
    </div>
  ));
}

function knownKey(scope: string, item: Omit<KnownPasswordItem, "kind">) {
  return `${scope}:known:${item.text}`;
}

export function PasswordList(props: PasswordListProps) {
  const identity = JSON.stringify([props.scope, props.defaultRevealed ?? true]);
  return <PasswordListSession key={identity} {...props} />;
}

function PasswordListSession({
  known,
  hiddenCount,
  scope,
  heading,
  defaultRevealed = true,
}: PasswordListProps) {
  const keys = known.map((item) => knownKey(scope, item));
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const pinned = new Set(
    keys.filter((key) => choices.get(key) ?? defaultRevealed),
  );
  const [bulkHideVersion, setBulkHideVersion] = useState(0);

  const hasKnown = keys.length > 0;
  const allPinned = hasKnown && keys.every((key) => pinned.has(key));
  const items: PasswordPresentationItem[] = [
    ...known.map((item) => ({ ...item, kind: "known" as const })),
    { kind: "locked", hiddenCount, scope },
  ];

  return (
    <>
      {heading && (
        <div className="section-heading password-list-heading">
          <div className="password-list-title">
            {heading}
            <CompactIconButton
              className="password-list-title__eye"
              aria-label={allPinned ? "隐藏全部口令" : "显示全部口令"}
              aria-pressed={allPinned}
              disabled={!hasKnown}
              onClick={() => {
                if (!hasKnown) return;
                if (allPinned) {
                  setChoices(new Map(keys.map((key) => [key, false])));
                  setBulkHideVersion((version) => version + 1);
                } else setChoices(new Map(keys.map((key) => [key, true])));
              }}
            >
              {allPinned ? (
                <EyeOff size={16} aria-hidden="true" />
              ) : (
                <Eye size={16} aria-hidden="true" />
              )}
            </CompactIconButton>
          </div>
        </div>
      )}
      <div className="password-list password-display-list">
        {items.map((item) => {
          if (item.kind === "known") {
            const key = knownKey(scope, item);
            return (
              <PasswordReveal
                key={key}
                text={item.text}
                label={item.label}
                scope={scope}
                pinned={pinned.has(key)}
                bulkHideVersion={bulkHideVersion}
                onPinnedChange={(nextPinned) =>
                  setChoices((current) => {
                    const next = new Map(current);
                    next.set(key, nextPinned);
                    return next;
                  })
                }
              />
            );
          }
          return (
            <LockedPasswords
              key={`${scope}:locked`}
              hiddenCount={item.hiddenCount}
              scope={item.scope}
            />
          );
        })}
      </div>
    </>
  );
}
