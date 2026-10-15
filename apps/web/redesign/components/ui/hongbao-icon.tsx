import { createLucideIcon } from "lucide-react";

/**
 * 红包: a tall envelope with a curved flap and the seal on the flap's edge.
 * Drawn on lucide's 24×24 grid with its 2px stroke, so it sits with the rest.
 */
export const HongbaoIcon = createLucideIcon("hongbao", [
  ["rect", { x: "5", y: "2", width: "14", height: "20", rx: "2", key: "body" }],
  ["path", { d: "M5 8.5c1.8 1.4 3.6 2.2 5.1 2.45", key: "flap-left" }],
  ["path", { d: "M13.9 10.95c1.5-.25 3.3-1.05 5.1-2.45", key: "flap-right" }],
  ["circle", { cx: "12", cy: "11", r: "2", key: "seal" }],
]);
