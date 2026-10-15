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
      /** Quiet links and small actions inside a line ("红包记录 ›"). */
      xs: "h-8 px-2.5 text-sm [&_svg]:size-4",
      sm: "h-9 px-3.5 text-sm [&_svg]:size-4",
      /** The 顶栏's controls. */
      bar: "h-10 px-3.5 text-sm [&_svg]:size-[18px]",
      md: "h-11 px-4.5 text-base [&_svg]:size-[18px]",
      lg: "h-12 px-5.5 text-base [&_svg]:size-5",
      "icon-xs": "size-8 [&_svg]:size-4",
      "icon-sm": "size-9 [&_svg]:size-[18px]",
      "icon-bar": "size-10 [&_svg]:size-5",
      icon: "size-11 [&_svg]:size-5",
    },
  },
  defaultVariants: { variant: "secondary", size: "md" },
});

export type ButtonSize = NonNullable<
  VariantProps<typeof buttonVariants>["size"]
>;

/**
 * Squircle radius per button height (32 → 11, 36 → 12, 40 → 13, 44 → 14,
 * 48 → 15).
 */
export const buttonRadius = {
  xs: 11,
  sm: 12,
  bar: 13,
  md: 14,
  lg: 15,
  "icon-xs": 11,
  "icon-sm": 12,
  "icon-bar": 13,
  icon: 14,
} satisfies Record<ButtonSize, number>;

/** Each size's height: a button is never narrower than it is tall. */
export const buttonHeight = {
  xs: 32,
  sm: 36,
  bar: 40,
  md: 44,
  lg: 48,
  "icon-xs": 32,
  "icon-sm": 36,
  "icon-bar": 40,
  icon: 44,
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
