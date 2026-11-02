// Built in place of apps/web/src/lib/session.ts (vite.config.ts): the
// forum's mini app has no session on 红包站. The parts it draws ask for one
// only where it leaves them out (lib/embedded.ts): nobody here, never ready.
export function useIdentity() {
  return {
    ready: false,
    failed: false,
    maintenance: false,
    checking: false,
    user: null,
    csrfToken: null,
    retry: () => {},
  };
}

export function useSessionUser() {
  return null;
}
