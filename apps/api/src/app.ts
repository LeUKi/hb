import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ActivityError } from "./activities/errors";
import { passwordRoutes } from "./activities/password-routes";
import { ActivityValidationError, activityRoutes } from "./activities/routes";
import { activityImageRoutes } from "./activity-images/routes";
import { adminRoutes } from "./admin/routes";
import { authRoutes } from "./auth/oauth";
import { balanceAdminRoutes } from "./balance/admin-routes";
import { RateLimitedError, RequestIssuesError } from "./balance/errors";
import { openRoutes } from "./balance/open-routes";
import { balanceRoutes } from "./balance/routes";
import { discoveryRoutes } from "./discovery/routes";
import type { ApiContext } from "./env";
import { MerchantChangeConfirmationError } from "./payments/configuration";
import { merchantRoutes } from "./payments/routes";
import { rankRoutes } from "./rank/routes";
import { AttemptCooldownError } from "./runtime/attempt-cooldown";
import {
  inMaintenanceMode,
  maintenanceResponse,
} from "./runtime/maintenance-mode";

export const app = new Hono<ApiContext>()
  // 维护模式: everything but the health check waits (runtime/maintenance-mode.ts).
  // A page opened at the API itself (signing in, the way back from LINUX DO)
  // goes to the start page instead, which says 系统维护中.
  .use("/api/*", async (c, next) => {
    if (!inMaintenanceMode(c.env) || c.req.path === "/api/health")
      return next();
    if (
      c.req.method === "GET" &&
      (c.req.header("Sec-Fetch-Mode") === "navigate" ||
        c.req.header("Accept")?.includes("text/html"))
    ) {
      c.header("Cache-Control", "no-store");
      return c.redirect("/", 302);
    }
    return c.json(maintenanceResponse, 503, {
      "Cache-Control": "no-store",
      "Retry-After": "60",
    });
  })
  .get("/api/health", (c) => c.json({ status: "ok" as const }))
  .route("/api", authRoutes)
  .route("/api", adminRoutes)
  .route("/api", balanceAdminRoutes)
  .route("/api", activityImageRoutes)
  .route("/api", activityRoutes)
  .route("/api", passwordRoutes)
  .route("/api", discoveryRoutes)
  .route("/api", rankRoutes)
  .route("/api", merchantRoutes)
  .route("/api", balanceRoutes)
  .route("/api", openRoutes)
  .notFound((c) =>
    c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "API route not found",
        },
      },
      404,
    ),
  )
  .onError((error, c) => {
    if (error instanceof ActivityError) {
      if (
        error instanceof AttemptCooldownError ||
        error instanceof RateLimitedError
      )
        c.header("Retry-After", String(error.retryAfter));
      return c.json(
        {
          ...(error instanceof AttemptCooldownError
            ? { attemptCooldown: error.attemptCooldown }
            : {}),
          error: {
            code: error.code,
            message: error.message,
            ...(error instanceof MerchantChangeConfirmationError
              ? {
                  impact: error.preview.impact,
                  confirmationToken: error.preview.confirmationToken,
                }
              : {}),
            ...(error instanceof ActivityValidationError ||
            error instanceof RequestIssuesError
              ? { issues: error.issues }
              : {}),
          },
        },
        error.status,
      );
    }
    if (error instanceof HTTPException) {
      return c.json(
        {
          error: {
            code: `HTTP_${error.status}`,
            message: error.message,
          },
        },
        error.status,
      );
    }

    console.error("api_error", {
      errorName: error instanceof Error ? error.name : typeof error,
    });

    return c.json(
      {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Unexpected API error",
        },
      },
      500,
    );
  });

export type AppType = typeof app;
