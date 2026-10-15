import "react";

declare module "react" {
  interface CSSProperties {
    /** CSS corner-shape (Chromium 139+): squircles drawn by the browser. */
    cornerShape?: string;
  }
}
