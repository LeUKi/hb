import type { ReactNode } from "react";

export function PageShell({
  eyebrow,
  title,
  description,
  action,
  children,
  narrow = false,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  narrow?: boolean;
}) {
  return (
    <section
      className={narrow ? "page-shell page-shell--narrow" : "page-shell"}
    >
      <header className="page-heading">
        <div className="page-heading__copy">
          {eyebrow ? <p className="page-eyebrow">{eyebrow}</p> : null}
          <h1>{title}</h1>
          {description ? (
            <div className="page-description">{description}</div>
          ) : null}
        </div>
        {action ? <div className="page-heading__action">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Surface({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`app-surface ${className}`}>{children}</section>;
}

export function FieldError({
  id,
  children,
}: {
  id?: string;
  children?: ReactNode;
}) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="field-error">
      {children}
    </p>
  );
}
