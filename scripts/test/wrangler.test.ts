import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  putSecret,
  repositoryRoot,
  runWrangler,
  SLOW_WRANGLER_TIMEOUT_MS,
  wranglerLabel,
  wranglerPath,
} from "../lib/environments";

// Wrangler never runs here: execFileSync answers the way Node and Bun do
// when a command finishes, fails or is stopped (sweep A1, 2026-11-21).
const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync,
}));

const LEAK = "https://upstream.example/client/v4?token=never-printed";

/** The error Node throws, with what wrangler printed attached. */
function ended(fields: { code?: string; signal?: string; status?: number }) {
  return Object.assign(new Error(`spawnSync node ${fields.code ?? ""}`), {
    status: null,
    signal: null,
    stdout: `Uploaded ${LEAK}`,
    stderr: `Authorization: Bearer ${LEAK}`,
    ...fields,
  });
}

function failWith(fields: Parameters<typeof ended>[0]) {
  execFileSync.mockImplementation(() => {
    throw ended(fields);
  });
}

/** The whole message `run` throws, with nothing else carried along. */
function thrown(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect((error as Error).cause).toBeUndefined();
    return (error as Error).message;
  }
  throw new Error("NOTHING_THROWN");
}

const apiConfig = join(repositoryRoot, "apps/api/wrangler.production.jsonc");
const deploy = [
  "deploy",
  "--config",
  join(repositoryRoot, "apps/web/dist/production/hb_api/wrangler.json"),
];

beforeEach(() => {
  execFileSync.mockReset();
});

describe("wrangler commands", () => {
  it("wait 120 s by default, with nothing on stdin, and give back what wrangler printed", () => {
    execFileSync.mockReturnValue('[{"results":[]}]');
    expect(runWrangler(["auth", "token", "--json"])).toBe('[{"results":[]}]');
    expect(execFileSync).toHaveBeenCalledWith(
      "node",
      [wranglerPath, "auth", "token", "--json"],
      expect.objectContaining({
        cwd: repositoryRoot,
        timeout: 120_000,
        input: undefined,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  it("take a deploy's time when asked", () => {
    execFileSync.mockReturnValue("");
    runWrangler(deploy, { timeout: SLOW_WRANGLER_TIMEOUT_MS, cwd: "/tmp" });
    expect(SLOW_WRANGLER_TIMEOUT_MS).toBe(600_000);
    expect(execFileSync).toHaveBeenCalledWith(
      "node",
      [wranglerPath, ...deploy],
      expect.objectContaining({ cwd: "/tmp", timeout: 600_000 }),
    );
  });

  it("tell a timeout, whose outcome is unknown, from a failure, and never repeat what wrangler printed", () => {
    const timedOut =
      "WRANGLER_TIMED_OUT: deploy --config apps/web/dist/production/hb_api/wrangler.json (outcome unknown, check the dashboard before retrying)";
    failWith({ code: "ETIMEDOUT", signal: "SIGTERM" });
    expect(thrown(() => runWrangler(deploy))).toBe(timedOut);
    // A wrangler that outlives the kill still timed out.
    failWith({ code: "ETIMEDOUT", status: 0 });
    expect(thrown(() => runWrangler(deploy))).toBe(timedOut);
    // Killed some other way, it never said how it went either.
    failWith({ signal: "SIGKILL" });
    expect(thrown(() => runWrangler(deploy))).toBe(timedOut);
    failWith({ status: 1 });
    expect(thrown(() => runWrangler(deploy))).toBe(
      "WRANGLER_COMMAND_FAILED: deploy --config apps/web/dist/production/hb_api/wrangler.json",
    );
  });

  it("are named by their words and config, never an option's value", () => {
    expect(
      wranglerLabel([
        "d1",
        "execute",
        "hb-production",
        "--config",
        apiConfig,
        "--remote",
        "--command",
        "SELECT secret FROM keys",
        "--json",
      ]),
    ).toBe(
      "d1 execute hb-production --config apps/api/wrangler.production.jsonc",
    );
    expect(
      wranglerLabel([
        "d1",
        "time-travel",
        "restore",
        "hb-staging",
        "--config",
        apiConfig,
        "--bookmark",
        "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683",
        "--json",
      ]),
    ).toBe(
      "d1 time-travel restore hb-staging --config apps/api/wrangler.production.jsonc",
    );
    expect(
      wranglerLabel([
        "d1",
        "export",
        "hb-production",
        "--config",
        apiConfig,
        "--remote",
        "--output",
        "/private/backups/payment.sql",
      ]),
    ).toBe(
      "d1 export hb-production --config apps/api/wrangler.production.jsonc",
    );
    expect(wranglerLabel(["auth", "token", "--json"])).toBe("auth token");
  });
});

describe("secrets", () => {
  it("go in on stdin, never in the arguments, with a deploy's time", () => {
    execFileSync.mockReturnValue("Success! Uploaded secret CAP_SECRET_KEY");
    expect(
      putSecret(apiConfig, "CAP_SECRET_KEY", "value-never-in-arguments"),
    ).toBeUndefined();
    const [command, args, options] = execFileSync.mock.calls[0] ?? [];
    expect(command).toBe("node");
    expect(args).toEqual([
      wranglerPath,
      "secret",
      "put",
      "CAP_SECRET_KEY",
      "--config",
      apiConfig,
    ]);
    expect(options).toMatchObject({
      cwd: repositoryRoot,
      input: "value-never-in-arguments",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: SLOW_WRANGLER_TIMEOUT_MS,
    });
  });

  it("say which secret and which Worker did not finish, never the value", () => {
    const put = () =>
      putSecret(apiConfig, "NOTICE_SMTP_TOKEN", "value-never-printed");
    failWith({ code: "ETIMEDOUT", signal: "SIGTERM" });
    expect(thrown(put)).toBe(
      "WRANGLER_TIMED_OUT: secret put NOTICE_SMTP_TOKEN --config apps/api/wrangler.production.jsonc (outcome unknown, check the dashboard before retrying)",
    );
    failWith({ status: 1 });
    expect(thrown(put)).toBe(
      "WRANGLER_COMMAND_FAILED: secret put NOTICE_SMTP_TOKEN --config apps/api/wrangler.production.jsonc",
    );
  });
});
