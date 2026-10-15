import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queueProbePayload } from "../deployment-probe";
import { cloudflareRequest } from "../lib/cloudflare-api";
import {
  configPath,
  environmentFrom,
  parseArguments,
  readConfig,
  validateEnvironment,
} from "../lib/environments";
import {
  inspectSQLite,
  rehearseSQLite,
  remoteBackupPlan,
} from "../payment-backup";
import { diagnosticQueries, diagnosticWarnings } from "../payment-diagnostics";
import { controlUpdate } from "../platform-controls";
import {
  inspectBrowserBundle,
  sanitizeBuild,
  sourceSnapshot,
} from "../release";

const temporary: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "hb-ops-test-"));
  temporary.push(path);
  return path;
}
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("release environment guards", () => {
  function configs(environment: "staging" | "production" = "staging") {
    return {
      web: readConfig(configPath(environment, "web")),
      api: readConfig(configPath(environment, "api")),
    };
  }

  it("accepts two separate configured domains and closed published environments", () => {
    for (const environment of ["staging", "production"] as const) {
      const { web, api } = configs(environment);
      api.vars = {
        ...api.vars,
        LDC_NETWORK_MODE: "disabled",
        LDC_STOP_NEW_OPENINGS: "true",
        LDC_STOP_NEW_CLAIMS: "true",
        LDC_STOP_SENDS: "true",
      };
      expect(
        validateEnvironment(environment, web, api, { allowPlaceholders: true })
          .queue,
      ).toBe(`hb-payments-${environment}`);
    }
  });

  it("compares D1 resource identities independently of generated migration paths", () => {
    const source = configs();
    const generated = structuredClone(source);
    if (generated.api.d1_databases?.[0])
      generated.api.d1_databases[0].migrations_dir =
        "../../../../api/migrations";
    const sourceResources = validateEnvironment(
      "staging",
      source.web,
      source.api,
    );
    expect(
      validateEnvironment("staging", generated.web, generated.api),
    ).toEqual(sourceResources);
    if (generated.api.d1_databases?.[0])
      generated.api.d1_databases[0].database_id =
        "ffffffff-ffff-ffff-ffff-ffffffffffff";
    expect(
      validateEnvironment("staging", generated.web, generated.api),
    ).not.toEqual(sourceResources);
  });

  it("rejects a cross-environment service binding and API public routes", () => {
    const { web, api } = configs();
    web.services = [{ binding: "API", service: "hb-api-production" }];
    expect(() => validateEnvironment("staging", web, api)).toThrow(
      "service binding",
    );
    web.services = [{ binding: "API", service: "hb-api-staging" }];
    api.routes = [{ pattern: "api.example.com" }];
    expect(() => validateEnvironment("staging", web, api)).toThrow("no public");
  });

  it("rejects placeholder resources and permits only explicit build-only templates", () => {
    const { web, api } = configs();
    if (api.d1_databases?.[0])
      api.d1_databases[0].database_id = "REPLACE_WITH_STAGING_D1_ID";
    expect(() => validateEnvironment("staging", web, api)).toThrow(
      "placeholders",
    );
    expect(() =>
      validateEnvironment("staging", web, api, { allowPlaceholders: true }),
    ).not.toThrow();
  });

  it("requires explicit stop flags and never enables live staging", () => {
    const { web, api } = configs();
    if (api.vars) delete api.vars.LDC_STOP_SENDS;
    expect(() =>
      validateEnvironment("staging", web, api, { allowPlaceholders: true }),
    ).toThrow("stop switches");
    api.vars = {
      ...api.vars,
      LDC_STOP_SENDS: "false",
      LDC_NETWORK_MODE: "live",
    };
    expect(() =>
      validateEnvironment("staging", web, api, {
        allowPlaceholders: true,
        allowLive: true,
      }),
    ).toThrow("staging cannot");
  });

  it("requires explicit live review and rejects local acceptance authorization", () => {
    const { web, api } = configs("production");
    api.vars = {
      ...api.vars,
      LDC_NETWORK_MODE: "live",
      LDC_STOP_SENDS: "false",
    };
    expect(() =>
      validateEnvironment("production", web, api, { allowPlaceholders: true }),
    ).toThrow("allow-live");
    expect(() =>
      validateEnvironment("production", web, api, {
        allowPlaceholders: true,
        allowLive: true,
      }),
    ).not.toThrow();
    api.vars.LDC_ACCEPTANCE_ID = "local-grant";
    expect(() =>
      validateEnvironment("production", web, api, { allowLive: true }),
    ).toThrow("authorization");
  });

  it("keeps production on hb.lafi.sh, with the old domain only to redirect", () => {
    const { web, api } = configs("production");
    expect(web.routes?.map((route) => route.pattern)).toEqual([
      "hb.lafi.sh",
      "meme.442224.xyz",
    ]);
    expect(api.vars?.APP_ORIGIN).toBe("https://hb.lafi.sh");
    const check = () =>
      validateEnvironment("production", web, api, {
        allowPlaceholders: true,
        allowLive: true,
      });
    expect(check).not.toThrow();
    // Another domain is not one the site moved from.
    web.routes = [
      ...(web.routes ?? []),
      { pattern: "other.example.com", custom_domain: true },
    ];
    expect(check).toThrow("custom domain");
    // The site's own domain comes first.
    web.routes = [
      { pattern: "meme.442224.xyz", custom_domain: true },
      { pattern: "hb.lafi.sh", custom_domain: true },
    ];
    expect(check).toThrow("custom domain");
  });

  it("requires a timed draw opening switch and keeps Stage closed", () => {
    const { web, api } = configs();
    if (api.vars) delete api.vars.LDC_TIMED_DRAW_ENABLED;
    expect(() => validateEnvironment("staging", web, api)).toThrow(
      "timed draw opening switch",
    );
    api.vars = { ...api.vars, LDC_TIMED_DRAW_ENABLED: "true" };
    expect(() => validateEnvironment("staging", web, api)).toThrow(
      "staging cannot enable timed draw",
    );
    const production = configs("production");
    production.api.vars = {
      ...production.api.vars,
      LDC_TIMED_DRAW_ENABLED: "true",
    };
    expect(() =>
      validateEnvironment("production", production.web, production.api, {
        allowLive: true,
      }),
    ).not.toThrow();
  });

  it("rejects mismatched producer/consumer and conflicting DO lifecycle mechanisms", () => {
    const { web, api } = configs();
    if (api.queues?.consumers?.[0])
      api.queues.consumers[0].queue = "wrong-queue";
    expect(() => validateEnvironment("staging", web, api)).toThrow(
      "queue producer",
    );
    if (api.queues?.consumers?.[0])
      api.queues.consumers[0].queue = "hb-payments-staging";
    api.migrations = [];
    expect(() => validateEnvironment("staging", web, api)).toThrow(
      "DO migrations",
    );
  });

  it("does not guess targets or accept duplicated/conflicting options", () => {
    expect(() => environmentFrom(undefined)).toThrow("ENVIRONMENT_REQUIRED");
    expect(() => environmentFrom("prod")).toThrow("ENVIRONMENT_REQUIRED");
    expect(() =>
      parseArguments(
        ["--env", "production", "--env", "staging"],
        ["--env"],
        [],
      ),
    ).toThrow("DUPLICATE");
    expect(() =>
      parseArguments(["--env", "--execute"], ["--env"], ["--execute"]),
    ).toThrow("MISSING");
  });

  it("detects server material in browser artifacts", () => {
    const path = directory();
    mkdirSync(join(path, "client"));
    writeFileSync(join(path, "client/app.js"), "console.log('status ok');");
    expect(() => inspectBrowserBundle(path)).not.toThrow();
    writeFileSync(
      join(path, "client/app.js"),
      "const leak='CONNECT_CLIENT_SECRET';",
    );
    expect(() => inspectBrowserBundle(path)).toThrow("SERVER_MATERIAL");
  });

  it("removes only generated secrets and normalizes empty DO migration defaults", () => {
    const path = directory();
    const source = join(directory(), ".dev.vars");
    writeFileSync(source, "local-source-must-remain");
    for (const name of ["hb_api", "hb_web"]) {
      mkdirSync(join(path, name));
      writeFileSync(
        join(path, name, ".dev.vars"),
        "generated-private-placeholder",
      );
      writeFileSync(
        join(path, name, "wrangler.json"),
        JSON.stringify({
          name,
          main: "index.js",
          exports: {
            ActivityDO: { type: "durable-object", storage: "sqlite" },
          },
          migrations: [],
        }),
      );
    }
    expect(sanitizeBuild(path)).toEqual({ removedEnvironmentFiles: 2 });
    expect(readFileSync(source, "utf8")).toBe("local-source-must-remain");
    expect(
      JSON.parse(readFileSync(join(path, "hb_api/wrangler.json"), "utf8")),
    ).toMatchObject({ exports: { ActivityDO: { storage: "sqlite" } } });
    expect(
      readConfig(join(path, "hb_api/wrangler.json")).migrations,
    ).toBeUndefined();
  });

  it("records source and tests without including local secrets or generated products", () => {
    const snapshot = sourceSnapshot();
    expect(snapshot.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    for (const path of ["DESIGN.md", "playwright.full-app.config.ts"])
      expect(snapshot.sources.some((file) => file.path === path)).toBe(true);
    expect(
      snapshot.sources.some(
        (file) => file.path === "scripts/test/operations.test.ts",
      ),
    ).toBe(true);
    expect(
      snapshot.sources.some((file) =>
        /(?:\/dist\/|\/node_modules\/|\/\.dev\.vars$|routeTree\.gen\.ts$)/.test(
          file.path,
        ),
      ),
    ).toBe(false);
  });
});

describe("operations safety", () => {
  it("constructs CAS control updates and refuses live staging", () => {
    expect(
      controlUpdate(
        "production",
        { "--allow-real-send": "false", "--expected-version": "7" },
        123,
      ),
    ).toContain("WHERE id='global' AND version=7");
    expect(
      controlUpdate(
        "production",
        { "--allow-real-send": "false", "--expected-version": "7" },
        123,
      ),
    ).toContain("version=version+1");
    expect(() =>
      controlUpdate("production", { "--allow-real-send": "true" }),
    ).toThrow("VERSION_REQUIRED");
    expect(() =>
      controlUpdate("staging", {
        "--allow-real-send": "true",
        "--expected-version": "1",
      }),
    ).toThrow("STAGING_REAL_MONEY");
    expect(() =>
      controlUpdate("production", {
        "--allow-real-send": "1",
        "--expected-version": "1",
      }),
    ).toThrow("TRUE_OR_FALSE");
  });

  it("only exposes allowlisted aggregate diagnostics", () => {
    for (const query of diagnosticQueries(1000)) {
      expect(query.sql.trim()).toMatch(/^SELECT\b/);
      expect(query.sql).not.toMatch(
        /\b(?:secret|encrypted_text|encrypted_value|password_digest|recipient_username|access_token)\b/i,
      );
    }
    expect(
      diagnosticWarnings({
        protection: [{ tasks: 1 }],
        outbox: [{ state: "undelivered", oldest_age_seconds: 601 }],
      }),
    ).toEqual(["PAYMENT_PROTECTION_ACTIVE", "OUTBOX_WAIT_OVER_TEN_MINUTES"]);
  });

  it("plans remote backups without executing and prevents production restore rehearsal", () => {
    expect(remoteBackupPlan("staging", true)).toMatchObject({
      environment: "staging",
      executedRemotely: false,
    });
    expect(() => remoteBackupPlan("production", true)).toThrow("STAGING_ONLY");
  });

  it("encodes only a synthetic queue probe, never a payment wake", () => {
    expect(queueProbePayload("probe_1")).toEqual({
      body: { type: "synthetic.probe", id: "probe_1" },
      content_type: "json",
    });
    expect(() => queueProbePayload("'unsafe")).toThrow("INVALID");
  });

  it("uses fixed Cloudflare API auth/redirect policies without leaking errors", async () => {
    const account = "a".repeat(32);
    const transport = vi
      .fn()
      .mockResolvedValue(
        Response.json({ success: true, result: [] }),
      ) as unknown as typeof fetch;
    await expect(
      cloudflareRequest(account, "/queues?per_page=100", "fake-credential", {
        transport,
      }),
    ).resolves.toEqual([]);
    expect(transport).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/${account}/queues?per_page=100`,
      expect.objectContaining({
        redirect: "error",
        headers: {
          Authorization: "Bearer fake-credential",
          "Content-Type": "application/json",
        },
      }),
    );
    const failed = vi
      .fn()
      .mockRejectedValue(new Error("secret-in-URL")) as unknown as typeof fetch;
    await expect(
      cloudflareRequest(account, "/queues", "fake", { transport: failed }),
    ).rejects.toThrow("CLOUDFLARE_API_UNAVAILABLE");
    await expect(
      cloudflareRequest(account, "https://evil.example", "fake", { transport }),
    ).rejects.toThrow("TARGET_INVALID");
  });
});

describe("typed backup content verification", () => {
  function sqlite(values: unknown[][]) {
    const path = join(directory(), "source.sqlite");
    execFileSync("python3", [
      "-c",
      "import json,sqlite3,sys;con=sqlite3.connect(sys.argv[1]);con.execute('CREATE TABLE fixture(a,b)');con.executemany('INSERT INTO fixture VALUES (?,?)',json.loads(sys.argv[2]));con.commit();con.close()",
      path,
      JSON.stringify(values),
    ]);
    return path;
  }

  it("distinguishes delimiter/newline ambiguities, NULL/empty and integer/text values", () => {
    for (const [a, b] of [
      [[["a|b", "c"]], [["a", "b|c"]]],
      [[[null, ""]], [["", ""]]],
      [[[1, ""]], [["1", ""]]],
      [[["a\nb", "c"]], [["a", "b\nc"]]],
    ]) {
      expect(
        inspectSQLite(sqlite(a as unknown[][])).tableHashes.fixture,
      ).not.toBe(inspectSQLite(sqlite(b as unknown[][])).tableHashes.fixture);
    }
  });

  it("copies into an isolated restore, retains exact content and keeps backup private", () => {
    const source = sqlite([
      ["stable-id", "v1:encrypted-placeholder"],
      ["second", null],
    ]);
    const before = readFileSync(source);
    const result = rehearseSQLite(source, join(directory(), "backups"));
    expect(result.restoreRehearsal).toBe("passed");
    expect(result.inspection.foreignKeyCheck).toEqual([]);
    expect(result.inspection.integrityCheck).toEqual(["ok"]);
    expect(result.inspection).toEqual(inspectSQLite(source));
    expect(readFileSync(source)).toEqual(before);
    expect(statSync(result.backup).mode & 0o777).toBe(0o600);
  });
});
