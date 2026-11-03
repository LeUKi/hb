// Local only (`vite`, index.html): a stand-in for the forum's SDK, which its
// own preview does not provide, answering for the sample 红包 in
// dev-fixtures.ts (`?hb=password`, `direct`, `fish`, `draw`, `code`,
// `human`, `ended`, `stranger`, `taken`, `scheduled`, `self`, `preview`, `long`;
// none: no 红包; `?guest`: not signed in; `&title=`, `&note=`), people's pictures, and a bar to switch what the forum would — light or dark,
// reduced motion. Never in app.js.
import type { MiniClaimInput, MiniLiveMessage } from "@hb/contracts";
import { caseNames, caseOf, rosterPage } from "./dev-fixtures";
import type { LaunchParameters, MiniSdk, MiniSocket, MiniTheme } from "./sdk";

const query = new URLSearchParams(window.location.search);
const picked = query.get("hb");
const sample = picked ? caseOf(picked) : null;
// `&title=` and `&note=` try a sample with another title or 说明 (`&note=`
// empty: none), `&after=` another 附言, to see how tall the page gets.
if (sample) {
  const title = query.get("title");
  const note = query.get("note");
  if (title !== null) sample.read.activity.title = title;
  if (note !== null) sample.read.activity.beforeInfo = note;
  // `&after=`: the 附言 a claim here shows.
  const after = query.get("after");
  const claim = sample.claim;
  if (after !== null && claim)
    sample.claim = (password) => {
      const result = claim(password);
      if (result.result === "claimed") result.claim.afterClaimInfo = after;
      return result;
    };
}
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
/** `?guest`: not signed in to the 社区, which then lets the app reach nothing. */
const guest = query.has("guest");
const denied = () =>
  Object.assign(new Error("Permission denied"), { code: "PERMISSION_DENIED" });

/**
 * A member's picture, as the 社区 lends it (a Blob address): a tile in a
 * colour of their own; every seventh has none.
 */
function picture(id: number) {
  if (id % 7 === 3) return null;
  const hue = (id * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="hsl(${hue} 55% 55%)"/><circle cx="48" cy="38" r="18" fill="hsl(${hue} 60% 85%)"/><ellipse cx="48" cy="92" rx="34" ry="28" fill="hsl(${hue} 60% 85%)"/></svg>`;
  return URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
}

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
    getCurrent: async () =>
      guest
        ? null
        : {
            id: 332940,
            username: "lafish",
            name: "lafish",
            initials: "L",
            trustLevel: 2,
            avatarUrl: picture(332940),
          },
    getById: async (id) => {
      await wait(150 + Math.random() * 300);
      return {
        id,
        username: `user${id}`,
        name: `user${id}`,
        initials: "U",
        trustLevel: 1,
        avatarUrl: picture(id),
      };
    },
  },
  http: {
    request: async (endpoint, options) => {
      if (guest) throw denied();
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
  webSocket: {
    connect: async () => {
      if (guest) throw denied();
      return liveSocket();
    },
  },
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
