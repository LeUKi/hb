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

export type MiniSdk = {
  readonly ready: Promise<void>;
  readonly permissions: { has(permission: string): boolean };
  readonly lifecycle: { ready(): Promise<void> };
  readonly theme: {
    get(): Promise<MiniTheme>;
    onChange(listener: (theme: MiniTheme) => void): () => void;
  };
  readonly launch: { getParameters(): Promise<LaunchParameters> };
};

export function getSdk(): MiniSdk | null {
  return (globalThis as { miniApp?: MiniSdk }).miniApp ?? null;
}
