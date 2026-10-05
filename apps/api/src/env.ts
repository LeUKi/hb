export type ApiBindings = CloudflareEnv & {
  APP_ORIGIN?: string;
  CONNECT_CLIENT_ID?: string;
  CONNECT_CLIENT_SECRET?: string;
  ENCRYPTION_KEYS?: string;
  ENCRYPTION_KEY_VERSION?: string;
  PASSWORD_DIGEST_KEY?: string;
  CLAIM_ATTEMPTS_PER_MINUTE?: string;
  GLOBAL_REDEMPTIONS_PER_MINUTE?: string;
  APP_ENV?: string;
  LDC_NETWORK_MODE?: string;
  LDC_ACCEPTANCE_ID?: string;
  LDC_STOP_NEW_OPENINGS?: string;
  LDC_STOP_NEW_CLAIMS?: string;
  LDC_STOP_SENDS?: string;
};

export type ApiVariables = {
  userId?: string;
};

export type ApiContext = {
  Bindings: ApiBindings;
  Variables: ApiVariables;
};
