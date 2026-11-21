import type { AppType } from "@hb/api/types";
import { hc } from "hono/client";
import { answered } from "./lib/answered";

// Every request through the client gets no-answer words in Chinese (07 §1)
// in place of the browser's “Load failed” / “Failed to fetch”; answered is
// its own file, so lib/activities.ts can use it too without an import
// cycle (sweep 2026-11-21).
export const api = hc<AppType>(window.location.origin, { fetch: answered });
