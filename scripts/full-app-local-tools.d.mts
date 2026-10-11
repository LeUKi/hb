export const localExperienceDefaults: {
  publicPort: number;
  controlPort: number;
  internalPort: number;
};

export function localExperienceConfigFromEnv(env?: NodeJS.ProcessEnv): {
  enabled: boolean;
  publicPort: number;
  controlPort: number;
  internalPort: number;
  publicOrigin: string;
};

export function localRoleOptions(): Array<{
  role: string;
  name: string;
  username: string;
  liteauth: boolean;
}>;

export function rewriteOAuthAuthorizeLocation(
  location: string | null | undefined,
  publicOrigin: string,
): string | null;

export function createLocalExperienceHome(publicOrigin: string): string;

export function createLocalLoginResponse(
  url: string,
  publicOrigin: string,
  ResponseImpl?: typeof Response,
): Response;

export function createLocalOAuthAuthorizeResponse(
  url: string,
  publicOrigin: string,
  cookieHeader?: string,
  ResponseImpl?: typeof Response,
): Response;

export function createLocalAvatarResponse(
  url: string,
  publicOrigin: string,
  ResponseImpl?: typeof Response,
): Response;

export function localAvatarUrl(publicOrigin: string, role: string): string;

export function nodeHeadersFromWebResponse(
  headers: Headers,
  rewrittenLocation?: string,
): Record<string, string | string[]>;
