/*!
 * lafish的红包站 · 附带网页 SDK v1
 * 说明：https://hb.lafi.sh/help/page#sdk
 * v1 已有的写法不改，只修错、加新的。
 */

// The page beside a 红包 talks to the 红包 page around it (docs/judge-page-
// design.md §3, §11.8): only to the site this file was loaded from, and
// only to the window it is framed in. Everything goes by postMessage; the
// 红包 page answers what it can and pushes what changes.
(() => {
  if (window.hb) return;
  const script = document.currentScript;
  const site =
    script instanceof HTMLScriptElement && script.src
      ? new URL(script.src).origin
      : "https://hb.lafi.sh";
  const host = window.parent;
  const kinds = ["view", "hongbao", "announce", "me"];
  const listeners = new Map(kinds.map((kind) => [kind, new Set()]));
  /** Asks sent and not yet answered, by number. */
  const waiting = new Map();
  let sequence = 0;
  /** What the 红包 page said on connecting, kept up to date by its pushes. */
  let state = null;
  let connecting = null;

  const failure = (code, text) => Object.assign(new Error(text), { code });

  function ask(type, fields) {
    return new Promise((resolve, reject) => {
      sequence += 1;
      waiting.set(sequence, { resolve, reject });
      host.postMessage({ hb: 1, id: sequence, type, ...fields }, site);
    });
  }

  function tell(kind, value) {
    for (const listener of listeners.get(kind)) {
      try {
        listener(value);
      } catch (error) {
        // One listener's error is the page's own; the others still hear.
        setTimeout(() => {
          throw error;
        });
      }
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== host || event.origin !== site) return;
    const message = event.data;
    if (message?.hb !== 1) return;
    if (typeof message.re === "number") {
      const pending = waiting.get(message.re);
      if (!pending) return;
      waiting.delete(message.re);
      if (message.error)
        pending.reject(failure(message.error.code, message.error.message));
      else pending.resolve(message.value);
      return;
    }
    if (!state) return;
    // How far the 红包 page's clock (the server's) is from this one.
    if (message.event === "clock") {
      if (typeof message.value === "number") state.clock = message.value;
      return;
    }
    if (!kinds.includes(message.event)) return;
    if (message.event === "announce") {
      // Several at once: oldest first, one by one.
      for (const line of message.value) tell("announce", line);
      return;
    }
    state[message.event] = message.value;
    tell(message.event, message.value);
  });

  /**
   * Knocks until the 红包 page answers (a quarter second apart, ten
   * seconds in all). Opened on its own or framed elsewhere, nobody does.
   */
  function ready() {
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      if (host === window) {
        reject(failure("not_embedded", "没有接上红包页：网页要在红包页里打开"));
        return;
      }
      const knocks = [];
      let timer = 0;
      const knock = () => {
        if (knocks.length >= 40) {
          clearInterval(timer);
          for (const id of knocks) waiting.delete(id);
          reject(failure("not_embedded", "没有接上红包页"));
          return;
        }
        sequence += 1;
        const id = sequence;
        knocks.push(id);
        waiting.set(id, {
          resolve: (value) => {
            clearInterval(timer);
            for (const other of knocks) waiting.delete(other);
            state = value;
            resolve({
              hongbao: value.hongbao,
              viewer: value.viewer,
              theme: value.theme,
            });
          },
          reject,
        });
        host.postMessage({ hb: 1, id, type: "hello", version: 1 }, site);
      };
      timer = setInterval(knock, 250);
      knock();
    });
    // Not connected: the next call knocks again.
    connecting.catch(() => {
      connecting = null;
    });
    return connecting;
  }

  const hb = Object.freeze({
    version: 1,
    ready,
    /** 判定器的公开数据：{ summary, data, at }，没有时 null。 */
    async view() {
      await ready();
      return state.view;
    },
    /** 看的人自己的情况：能不能参加、冷却到什么时候、领到多少。 */
    async me() {
      await ready();
      return state.me;
    },
    /** 按服务器校准过的当前时间（毫秒）；看的人没登录时是本机时间。 */
    now() {
      return Date.now() + (state?.clock ?? 0);
    },
    /** 请红包页弹出登录卡片；要在看的人点了网页里的按钮时调用。 */
    async login() {
      if (navigator.userActivation && !navigator.userActivation.isActive)
        throw failure(
          "no_gesture",
          "hb.login 要在看的人点了网页里的按钮时调用",
        );
      await ready();
      return ask("login", {});
    },
    /** view、hongbao、announce、me 有变化时调用 listener；返回取消订阅的函数。 */
    on(kind, listener) {
      if (!listeners.has(kind))
        throw new TypeError(
          `hb.on：没有“${kind}”，只有 view、hongbao、announce、me`,
        );
      if (typeof listener !== "function")
        throw new TypeError("hb.on：第二个参数要是函数");
      listeners.get(kind).add(listener);
      // Listening connects; a page opened on its own just hears nothing.
      ready().catch(() => {});
      return () => {
        listeners.get(kind).delete(listener);
      };
    },
    /** 替看的人提交一次；第一次会先问他允不允许。 */
    async submit(input) {
      if (typeof input !== "string")
        throw new TypeError("hb.submit：输入要是字符串");
      await ready();
      return ask("submit", { input });
    },
    /** 把内容填进这个红包的指令框，不提交；所有红包都能用。 */
    async fill(text) {
      if (typeof text !== "string")
        throw new TypeError("hb.fill：内容要是字符串");
      await ready();
      return ask("fill", { text });
    },
    /** 看的人自己的提交，新的在前，一次 20 条；没登录时 null。 */
    async mine(next) {
      if (next !== undefined && next !== null && typeof next !== "string")
        throw new TypeError("hb.mine：参数是上一次拿到的 next");
      await ready();
      return ask("mine", { next: next ?? null });
    },
  });
  Object.defineProperty(window, "hb", { value: hb, enumerable: true });
})();
