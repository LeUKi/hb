import { forumUserIdOf } from "@hb/contracts";
import type { AvatarSource } from "../../web/src/lib/avatar-source";
import type { MiniSdk } from "./sdk";

// People's pictures as the 社区 has them (docs/mini-app-design.md §7):
// 红包站 names each person by their 社区 id (forumAvatar), the 社区 lends a
// Blob address for this run (sdk.user.getById, user.lookup). The 社区 takes
// 60 SDK calls a minute for everything, reads and claims included, so
// pictures take at most half of them, four at a time.

const PER_MINUTE = 30;
const AT_ONCE = 4;

export function forumAvatars(sdk: MiniSdk): AvatarSource {
  /** By 社区 id: its address, or null for none. */
  const known = new Map<number, string | null>();
  const asked = new Map<number, Promise<string | null>>();
  const lookup = sdk.permissions.has("user.lookup");

  const queue: (() => void)[] = [];
  const started: number[] = [];
  let running = 0;
  let waiting: ReturnType<typeof setTimeout> | null = null;
  const pump = () => {
    while (queue.length && running < AT_ONCE) {
      const now = Date.now();
      while (started.length && now - (started[0] ?? 0) >= 60_000)
        started.shift();
      if (started.length >= PER_MINUTE) {
        // Again once the oldest of the minute's lookups is a minute old.
        if (!waiting)
          waiting = setTimeout(
            () => {
              waiting = null;
              pump();
            },
            60_000 - (now - (started[0] ?? now)) + 50,
          );
        return;
      }
      started.push(now);
      running += 1;
      queue.shift()?.();
    }
  };
  const inTurn = <T>(work: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(
        () =>
          void work()
            .then(resolve, reject)
            .finally(() => {
              running -= 1;
              pump();
            }),
      );
      pump();
    });

  // Their own picture comes with who they are, no lookup.
  if (sdk.permissions.has("user.read"))
    void sdk.user.getCurrent().then(
      (user) => {
        if (user) known.set(user.id, user.avatarUrl ?? null);
      },
      () => {},
    );

  return {
    peek(src) {
      const id = forumUserIdOf(src);
      if (id === null) return null;
      const url = known.get(id);
      return url === undefined && !lookup ? null : url;
    },
    load(src) {
      const id = forumUserIdOf(src);
      const ready = id === null ? null : known.get(id);
      if (id === null || ready !== undefined || !lookup)
        return Promise.resolve(ready ?? null);
      let pending = asked.get(id);
      if (!pending) {
        pending = inTurn(() => sdk.user.getById(id))
          .then(
            (user) => {
              const url = user?.avatarUrl ?? null;
              known.set(id, url);
              return url;
            },
            (error: unknown) => {
              // Asked too often: another time. Anything else: the character.
              if ((error as { code?: string } | null)?.code !== "RATE_LIMIT")
                known.set(id, null);
              return null;
            },
          )
          .finally(() => asked.delete(id));
        asked.set(id, pending);
      }
      return pending;
    },
  };
}
