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
};

export type ApiBindings = Omit<CloudflareEnv, keyof ApiEnvVars> & ApiEnvVars;

export type ApiVariables = {
  userId?: string;
};

export type ApiContext = {
  Bindings: ApiBindings;
  Variables: ApiVariables;
};
