import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { getDefaultStore, Provider as JotaiProvider } from "jotai";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { failBoot, markBoot } from "./lib/boot";
import { createAppQueryClient } from "./lib/query-cache";
import { router } from "./router";
import "./styles.css";

// Imports evaluate first, so this marks "the whole bundle has run".
markBoot("script");

const root = document.getElementById("root");
if (!root) throw new Error("App root is missing");

const queryClient = createAppQueryClient();

createRoot(root, {
  onUncaughtError: () => failBoot("render"),
}).render(
  <StrictMode>
    {/* One store: code outside components (the omnibox controller, a
        lookup finishing later) writes to the default store too. */}
    <JotaiProvider store={getDefaultStore()}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </JotaiProvider>
  </StrictMode>,
);
