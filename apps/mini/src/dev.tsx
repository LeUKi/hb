// Local only (`vite`, index.html): a stand-in for the forum's SDK, which its
// own preview does not provide, answering for the sample 红包 in
// dev-fixtures.ts (`?hb=password`, `direct`, `fish`, `draw`, `code`,
// `human`, `ended`, `stranger`, `taken`, `scheduled`, `self`; none: no
// 红包), and a bar to switch what the forum would — light or dark, reduced
// motion. Never in app.js.
import type { MiniClaimInput, MiniLiveMessage } from "@hb/contracts";
import { caseNames, caseOf, rosterPage } from "./dev-fixtures";
import type { LaunchParameters, MiniSdk, MiniSocket, MiniTheme } from "./sdk";

const query = new URLSearchParams(window.location.search);
const picked = query.get("hb");
const sample = picked ? caseOf(picked) : null;
// The forum's default light and dark backgrounds and text.
const forum = {
  light: { background: "#ffffff", text: "#222222" },
  dark: { background: "#222222", text: "#dddddd" },
};
const mode = query.get("mode") === "dark" ? "dark" : "light";
let theme: MiniTheme = {
  mode,
  ...forum[mode],
  accent: "#d3282f",
  border: "#dddddd",
  locale: "zh_CN",
  reducedMotion: query.has("reduce"),
  viewport: { width: window.innerWidth, height: window.innerHeight },
};
const listeners = new Set<(theme: MiniTheme) => void>();
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The live channel: who is watching, a claim now and then. */
function liveSocket(): MiniSocket {
  const handlers = { message: new Set<(value: unknown) => void>() };
  let seq = 1;
  let viewers = 3;
  const send = (message: MiniLiveMessage) => {
    for (const handler of handlers.message) handler(message);
  };
  const timer = window.setInterval(() => {
    viewers += Math.random() < 0.5 ? 1 : -1;
    seq += 1;
    send({ type: "viewers", count: Math.max(2, viewers), seq });
  }, 4000);
  queueMicrotask(() => send({ type: "viewers", count: viewers, seq }));
  return {
    ready: Promise.resolve(),
    close: async () => {
      window.clearInterval(timer);
      return null;
    },
    on: ((event: string, listener: (value: unknown) => void) => {
      if (event === "message") handlers.message.add(listener);
      return () => handlers.message.delete(listener);
    }) as MiniSocket["on"],
  };
}

const sdk: MiniSdk = {
  ready: Promise.resolve(),
  permissions: { has: () => true },
  lifecycle: {
    ready: async () => console.info("[stand-in SDK] lifecycle.ready()"),
  },
  theme: {
    get: async () => theme,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
  launch: {
    getParameters: async (): Promise<LaunchParameters> => {
      const result: Record<string, string[]> = {};
      for (const key of new Set(query.keys())) result[key] = query.getAll(key);
      // The forum link carries the 红包's id; here the sample's.
      if (sample) result.hb = [sample.read.activity.id];
      return { query: result, hash: window.location.hash.slice(1) };
    },
  },
  user: {
    getCurrent: async () => ({
      id: 332940,
      username: "lafish",
      name: "lafish",
      initials: "L",
    }),
  },
  http: {
    request: async (endpoint, options) => {
      await wait(endpoint === "claim" ? 900 : 500);
      if (!sample)
        return {
          status: 404,
          headers: {},
          body: {
            error: { code: "ACTIVITY_NOT_FOUND", message: "未找到红包" },
          },
        };
      if (endpoint === "hongbao")
        return { status: 200, headers: {}, body: sample.read };
      if (endpoint === "roster")
        return {
          status: 200,
          headers: {},
          body: rosterPage(
            options?.query?.kind === "registrations"
              ? "registrations"
              : "claims",
            options?.query?.cursor,
          ),
        };
      const input = options?.json as MiniClaimInput;
      // A first-timer: an account from the forum's name, unless it is taken.
      if (!sample.read.known && (!input.forumUser || picked === "taken"))
        return {
          status: 403,
          headers: {},
          body: {
            error: {
              code: "SIGN_IN_FIRST",
              message:
                "这个用户名在红包站对应的是另一个账号，请先到红包站登录一次。",
            },
          },
        };
      return {
        status: 200,
        headers: {},
        body: sample.claim?.(input.password) ?? { result: "ended" },
      };
    },
  },
  webSocket: { connect: async () => liveSocket() },
  clipboard: {
    writeText: async (text) => {
      await navigator.clipboard?.writeText(text);
      return null;
    },
  },
};
(globalThis as { miniApp?: MiniSdk }).miniApp = sdk;

function set(next: Partial<MiniTheme>) {
  theme = { ...theme, ...(next.mode && forum[next.mode]), ...next };
  for (const listener of listeners) listener(theme);
  paint();
}

const bar = document.getElementById("dev-bar");
function paint() {
  if (!bar) return;
  const pick = document.createElement("select");
  pick.setAttribute("aria-label", "示例红包");
  for (const name of ["", ...caseNames]) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name || "没有红包";
    option.selected = name === (picked ?? "");
    pick.append(option);
  }
  pick.addEventListener("change", () => {
    if (pick.value) query.set("hb", pick.value);
    else query.delete("hb");
    window.location.search = query.toString();
  });
  bar.replaceChildren(
    pick,
    ...[
      [
        theme.mode === "dark" ? "切到浅色" : "切到深色",
        () => set({ mode: theme.mode === "dark" ? "light" : "dark" }),
      ],
      [
        theme.reducedMotion ? "恢复动画" : "减少动画",
        () => set({ reducedMotion: !theme.reducedMotion }),
      ],
    ].map(([label, action]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label as string;
      button.addEventListener("click", action as () => void);
      return button;
    }),
  );
}
paint();

await import("./main");
