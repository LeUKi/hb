import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, CSSProperties, Ref } from "react";
import { cn } from "../../lib/cn";
import { SMOOTHING } from "../../lib/squircle-path";
import { MorphLabel } from "./morph-label";
import { cornerShape, SquircleFill, useNativeSquircle } from "./squircle";

// Visual language lives in the .btn component classes (styles.css); cva only
// maps props to them plus sizes.
export const buttonVariants = cva("btn", {
  variants: {
    variant: {
      primary: "btn-primary",
      secondary: "btn-secondary",
      ghost: "btn-ghost",
      danger: "btn-danger",
    },
    size: {
      sm: "h-9 px-3.5 text-sm [&_svg]:size-4",
      md: "h-11 px-4.5 text-base [&_svg]:size-[18px]",
      lg: "h-12 px-5.5 text-base [&_svg]:size-5",
      icon: "size-11 [&_svg]:size-5",
      "icon-sm": "size-9 [&_svg]:size-[18px]",
    },
  },
  defaultVariants: { variant: "secondary", size: "md" },
});

type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

/** Squircle radius per button height (36 → 12, 40 → 13, 44 → 14, 48 → 15). */
export const buttonRadius = {
  sm: 12,
  md: 14,
  lg: 15,
  icon: 14,
  "icon-sm": 12,
} satisfies Record<ButtonSize, number>;

/** Each size's height: a button is never narrower than it is tall. */
const buttonHeight = {
  sm: 36,
  md: 44,
  lg: 48,
  icon: 44,
  "icon-sm": 36,
} satisfies Record<ButtonSize, number>;

/**
 * Radius variable for a .btn element of the given height (the button itself
 * carries the drop shadow, unclipped). Natively it takes the fill's
 * superellipse, from the height alone: that is what caps a button's corners.
 */
export function useButtonShape(radius: number, height: number): CSSProperties {
  const native = useNativeSquircle();
  if (!native) return { "--btn-radius": `${radius}px` } as CSSProperties;
  const shape = cornerShape(height, height, radius, SMOOTHING);
  return {
    "--btn-radius": `${shape.borderRadius}px`,
    cornerShape: shape.cornerShape,
  } as CSSProperties;
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    ref?: Ref<HTMLButtonElement>;
    /** Where the words sit while they change: "start" for left-set buttons. */
    labelAlign?: "center" | "start";
  };

/** A button whose words can change in place (see MorphLabel). */
export function Button({
  className,
  variant,
  size,
  type = "button",
  style,
  labelAlign,
  children,
  ...props
}: ButtonProps) {
  const radius = buttonRadius[size ?? "md"];
  const shape = useButtonShape(radius, buttonHeight[size ?? "md"]);
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      style={{ ...shape, ...style }}
      {...props}
    >
      <SquircleFill radius={radius} />
      <MorphLabel align={labelAlign}>{children}</MorphLabel>
    </button>
  );
}
