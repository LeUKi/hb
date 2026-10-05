import type { AppType } from "@hb/api/types";
import { hc } from "hono/client";

export const api = hc<AppType>(window.location.origin);
