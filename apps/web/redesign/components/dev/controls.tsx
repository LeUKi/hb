import type { ReactNode } from "react";
import { Squircle } from "../ui/squircle";

// Prototype-only controls shared by the dev toolbar and its dialogs.

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <Squircle radius={10}>
      {/* Wraps when the options outgrow the toolbar's 21rem. */}
      <div className="flex flex-wrap bg-fill-2 p-0.5">
        {options.map(([key, label]) => (
          <Squircle key={key} radius={8}>
            <button
              type="button"
              aria-pressed={value === key}
              onClick={() => onChange(key)}
              className={`h-8 flex-auto px-2 text-xs whitespace-nowrap transition-colors ${
                value === key
                  ? "bg-white font-medium text-ink raised"
                  : "text-ink-2 hover:text-ink"
              }`}
            >
              {label}
            </button>
          </Squircle>
        ))}
      </div>
    </Squircle>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
      <h3 className="text-xs font-medium text-ink-3">{title}</h3>
      {children}
    </section>
  );
}
