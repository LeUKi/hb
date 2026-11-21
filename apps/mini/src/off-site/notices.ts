// Built in place of apps/web/src/lib/notices.ts (vite.config.ts): 开放时提醒我
// needs a session on 红包站, and the 红包 page leaves it out here
// (lib/embedded.ts), words and all. Nothing here reaches the network.
export const watchWords = {};

export function useOpeningWatch(): never {
  throw new Error("开放时提醒我要到红包站。");
}

export function useSetOpeningWatch(): never {
  throw new Error("开放时提醒我要到红包站。");
}
