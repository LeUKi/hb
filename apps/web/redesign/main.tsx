import { RouterProvider } from "@tanstack/react-router";
import { getDefaultStore, Provider as JotaiProvider } from "jotai";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { failBoot, markBoot } from "./lib/boot";
import { router } from "./router";
import "./styles.css";

// Imports evaluate first, so this marks "the whole bundle has run".
markBoot("script");

const root = document.getElementById("root");
if (!root) throw new Error("Redesign root is missing");

createRoot(root, {
  onUncaughtError: () => failBoot("render"),
}).render(
  <StrictMode>
    {/* One store: code outside components (a merchant's credential check
        finishing later) writes to the default store too. */}
    <JotaiProvider store={getDefaultStore()}>
      <RouterProvider router={router} />
    </JotaiProvider>
  </StrictMode>,
);
