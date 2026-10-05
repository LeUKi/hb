import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ActivityError } from "./activities/errors";
import { passwordRoutes } from "./activities/password-routes";
import { ActivityValidationError, activityRoutes } from "./activities/routes";
import { authRoutes } from "./auth/oauth";
import { discoveryRoutes } from "./discovery/routes";
import { GlobalRateLimitError } from "./discovery/service";
import type { ApiContext } from "./env";
import { merchantRoutes } from "./payments/routes";

export const app = new Hono<ApiContext>()
  .get("/api/health", (c) => c.json({ status: "ok" as const }))
  .route("/api", authRoutes)
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
      if (error instanceof GlobalRateLimitError)
        c.header("Retry-After", String(error.retryAfter));
      return c.json(
        {
          error: {
            code: error.code,
            message: error.message,
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
