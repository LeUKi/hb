import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ActivityError } from "./activities/errors";
import { passwordRoutes } from "./activities/password-routes";
import { ActivityValidationError, activityRoutes } from "./activities/routes";
import { activityImageRoutes } from "./activity-images/routes";
import { loginSettingsAdminRoutes } from "./admin/login-settings";
import { adminRoutes } from "./admin/routes";
import { authRoutes } from "./auth/oauth";
import { discoveryRoutes } from "./discovery/routes";
import type { ApiContext } from "./env";
import { MerchantChangeConfirmationError } from "./payments/configuration";
import { merchantRoutes } from "./payments/routes";
import { AttemptCooldownError } from "./runtime/attempt-cooldown";

export const app = new Hono<ApiContext>()
  .get("/api/health", (c) => c.json({ status: "ok" as const }))
  .route("/api", authRoutes)
  .route("/api", adminRoutes)
  .route("/api", loginSettingsAdminRoutes)
  .route("/api", activityImageRoutes)
  .route("/api", activityRoutes)
  .route("/api", passwordRoutes)
  .route("/api", discoveryRoutes)
  .route("/api", merchantRoutes)
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
      if (error instanceof AttemptCooldownError)
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
            ...(error instanceof ActivityValidationError
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
