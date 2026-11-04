// cf:typegen types each key of .dev.vars.example as a string that is always
// set. A deployment may leave any of them unset, so these replace those types.
type ApiEnvVars = {
  APP_ORIGIN?: string;
  CONNECT_CLIENT_ID?: string;
  CONNECT_CLIENT_SECRET?: string;
  ENCRYPTION_KEYS?: string;
  ENCRYPTION_KEY_VERSION?: string;
  PASSWORD_DIGEST_KEY?: string;
  /** Turnstile (领取前人机验证): the public site key, and its secret. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  ADMIN_LINUX_DO_IDS?: string;
  APP_ENV?: string;
  LDC_NETWORK_MODE?: string;
  LDC_ACCEPTANCE_ID?: string;
  LDC_STOP_NEW_OPENINGS?: string;
  LDC_STOP_NEW_CLAIMS?: string;
  LDC_STOP_SENDS?: string;
  LDC_TIMED_DRAW_ENABLED?: string;
  /** drand nodes a 限时开奖 v2 takes its round from, comma-separated (default: Cloudflare's, then drand's own). */
  DRAND_URLS?: string;
  /** "true" while D1 is being moved: nothing writes (runtime/maintenance.ts). */
  MAINTENANCE_MODE?: string;
  /** Where Durable Objects are created, and new names for long-lived ones (runtime/objects.ts). */
  DO_LOCATION_HINT?: string;
  DO_NAME_PREFIX?: string;
  /** 附带网页认人: private P-256 JWKs, the first signing (activities/page-identity.ts). */
  PAGE_IDENTITY_KEYS?: string;
  /**
   * 社区小程序 (mini/platform-token.ts): the forum app's id, the forum
   * (default https://linux.do), which builds this deployment takes
   * ("sandbox" on Stage, "production"), and the forum's public key for
   * their tokens (PEM or JWK). Without all of them the mini app's routes
   * answer 503.
   */
  MINI_APP_ID?: string;
  MINI_APP_ISSUER?: string;
  MINI_APP_CHANNEL?: string;
  MINI_APP_PUBLIC_KEY?: string;
  /**
   * 压测 (runtime/stage-load-test.ts): set on Stage only, with APP_ENV
   * staging; anywhere else its routes answer 404.
   */
  STAGE_LOAD_TEST_KEY?: string;
  /** "true" on Stage for the load test's simulated merchants (runtime/controls.ts). */
  STAGE_SIMULATED_PAYMENTS?: string;
};

export type ApiBindings = Omit<CloudflareEnv, keyof ApiEnvVars> & ApiEnvVars;

export type ApiVariables = {
  userId?: string;
};

export type ApiContext = {
  Bindings: ApiBindings;
  Variables: ApiVariables;
};
