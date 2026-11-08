// The forum's mini-app SDK, as far as this app uses it. The platform installs
// it as globalThis.miniApp before app.js runs (its own getSDK() only reads
// that); src/dev.tsx installs a stand-in for local work.

export type MiniTheme = {
  mode: "light" | "dark";
  background: string;
  text: string;
  accent: string;
  border: string;
  /** Discourse locale code, such as zh_CN. */
  locale: string;
  reducedMotion: boolean;
  viewport: { width: number; height: number };
};

export type LaunchParameters = {
  query: Record<string, string[]>;
  hash: string;
};

export type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

/** An SDK connection exchanging JSON messages. */
export type MiniSocket = {
  readonly ready: Promise<void>;
  close(): Promise<null>;
  on(event: "message", listener: (value: unknown) => void): () => void;
  on(event: "error", listener: (value: { code: string }) => void): () => void;
  on(
    event: "close",
    listener: (value: { code: number; reason: string }) => void,
  ): () => void;
};

export type MiniUser = {
  id: number;
  username: string;
  name: string;
  initials: string;
  /** 0–4, or null; for showing only, never what 红包站 trusts. */
  trustLevel: number | null;
  /** Their picture (288px), a Blob address for this run only, or null. */
  avatarUrl: string | null;
};

export type MiniSdk = {
  readonly ready: Promise<void>;
  readonly permissions: { has(permission: string): boolean };
  readonly lifecycle: { ready(): Promise<void> };
  readonly theme: {
    get(): Promise<MiniTheme>;
    onChange(listener: (theme: MiniTheme) => void): () => void;
  };
  readonly launch: { getParameters(): Promise<LaunchParameters> };
  /**
   * Null for a guest. Not signed: for showing, and a first-timer's name.
   * getById (user.lookup) is another member as the 社区 shows them.
   */
  readonly user: {
    getCurrent(): Promise<MiniUser | null>;
    getById(id: number): Promise<MiniUser | null>;
  };
  /** Only to the endpoints manifest.json declares, signed by the forum. */
  readonly http: {
    request(
      endpoint: string,
      options?: { query?: Record<string, string>; json?: unknown },
    ): Promise<HttpResponse>;
  };
  readonly webSocket: {
    connect(
      endpoint: string,
      options?: { query?: Record<string, string> },
    ): Promise<MiniSocket>;
  };
  /** The forum asks the player first. */
  readonly clipboard: { writeText(text: string): Promise<null> };
  /** A new tab, once the 社区 has shown where and the person said yes. */
  readonly links: { open(url: string): Promise<null> };
};

export function getSdk(): MiniSdk | null {
  return (globalThis as { miniApp?: MiniSdk }).miniApp ?? null;
}
