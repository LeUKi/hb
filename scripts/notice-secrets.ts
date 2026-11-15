// 私信通知's sending secrets (docs/notification-design.md §2.2, §8): the
// 社区 mailbox they go out from and its Mailu 认证令牌, asked for in the
// terminal (the token is not echoed) or read from NOTICE_SMTP_USER and
// NOTICE_SMTP_TOKEN, logged in once to mail.linux.do to check them (no mail
// is sent), then handed straight to Wrangler as the API's secrets. On Stage
// it also asks which LINUX DO ids may get mail. Nothing is printed or
// written down.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { connect } from "node:tls";
import {
  parseArguments,
  repositoryRoot,
  runMain,
  wranglerPath,
} from "./lib/environments";

type Deployed = "staging" | "production";

const SMTP_HOST = "mail.linux.do";
const SMTP_PORT = 465;

const apiConfig = (environment: Deployed) =>
  join(repositoryRoot, `apps/api/wrangler.${environment}.jsonc`);

function putSecret(environment: Deployed, name: string, value: string) {
  try {
    execFileSync(
      "node",
      [wranglerPath, "secret", "put", name, "--config", apiConfig(environment)],
      {
        cwd: repositoryRoot,
        input: value,
        stdio: ["pipe", "ignore", "pipe"],
        timeout: 120_000,
        env: {
          ...process.env,
          X_LOCAL_OBSERVABILITY: "false",
          WRANGLER_WRITE_LOGS: "false",
          WRANGLER_LOG_SANITIZE: "true",
        },
      },
    );
  } catch {
    throw new Error(`WRANGLER_SECRET_PUT_FAILED: ${environment} ${name}`);
  }
}

/** One line from the terminal, shown as it is typed. */
async function ask(question: string) {
  if (!process.stdin.isTTY) throw new Error("TERMINAL_REQUIRED");
  const lines = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await new Promise<string>((resolve) =>
      lines.question(question, (answer) => resolve(answer.trim())),
    );
  } finally {
    lines.close();
  }
}

/**
 * One line typed with nothing shown: the terminal in raw mode, every key
 * read here and none written back (readline echoes by itself, whatever
 * stty says). Backspace takes one back; Ctrl+C gives up.
 */
const ESCAPE_SEQUENCE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z~]`,
  "g",
);

export function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error("TERMINAL_REQUIRED");
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: Buffer) => {
      // Escape sequences (arrow keys, bracketed-paste marks) are not text.
      const text = chunk.toString("utf8").replace(ESCAPE_SEQUENCE, "");
      for (const character of text) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") return finish(new Error("CANCELLED"));
        if (character === "\u007f" || character === "\b")
          value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/**
 * Logs in to the 社区's mail server as the notices will (TLS on 465, AUTH
 * PLAIN), then leaves: null when it worked, else what the server said.
 */
export function checkLogin(
  user: string,
  password: string,
  host = SMTP_HOST,
  port = SMTP_PORT,
): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, servername: host });
    let buffer = "";
    let step: "greeting" | "ehlo" | "auth" | "quit" = "greeting";
    const done = (result: string | null) => {
      clearTimeout(timer);
      socket.end();
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done("timeout"), 20_000);
    socket.on("error", (error) => done(`connection: ${error.message}`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (/^\d{3}-/.test(line)) continue;
        const code = line.slice(0, 3);
        if (step === "greeting") {
          if (code !== "220") return done(line.slice(0, 120));
          step = "ehlo";
          socket.write("EHLO hb.lafi.sh\r\n");
        } else if (step === "ehlo") {
          if (code !== "250") return done(line.slice(0, 120));
          step = "auth";
          const credentials = Buffer.from(`\0${user}\0${password}`).toString(
            "base64",
          );
          socket.write(`AUTH PLAIN ${credentials}\r\n`);
        } else if (step === "auth") {
          if (code !== "235") return done(line.slice(0, 120));
          step = "quit";
          socket.write("QUIT\r\n");
          return done(null);
        }
      }
    });
  });
}

function environmentsFrom(value: string | undefined): Deployed[] {
  if (value === "staging" || value === "production") return [value];
  if (value === "both") return ["staging", "production"];
  throw new Error("ENVIRONMENT_REQUIRED: use --env staging|production|both");
}

async function main() {
  const args = parseArguments(
    process.argv.slice(2),
    ["--env"],
    ["--execute", "--no-check", "--help"],
  );
  if (args["--help"] || !args["--env"]) {
    console.log(
      "Usage: bun scripts/notice-secrets.ts --env staging|production|both [--execute] [--no-check]\n" +
        "  Asks for the 社区 mailbox (like name@linux.do) and its Mailu 认证令牌\n" +
        "  (webmail.linux.do → 认证令牌, Authorized IP left empty), or reads\n" +
        "  NOTICE_SMTP_USER and NOTICE_SMTP_TOKEN. Logs in to mail.linux.do once\n" +
        "  to check them (no mail is sent; --no-check skips it), then puts\n" +
        "  NOTICE_SMTP_USER and NOTICE_SMTP_TOKEN on the API. On Stage it also\n" +
        "  asks which LINUX DO 数字 ID may get mail (NOTICE_ALLOWED_LINUX_DO_IDS).\n" +
        "  Without --execute it only says what it would do.",
    );
    return;
  }
  const environments = environmentsFrom(args["--env"] as string);
  const plan = environments.flatMap((environment) => [
    `${environment}: NOTICE_SMTP_USER`,
    `${environment}: NOTICE_SMTP_TOKEN`,
    ...(environment === "staging"
      ? ["staging: NOTICE_ALLOWED_LINUX_DO_IDS"]
      : []),
  ]);
  if (!args["--execute"]) {
    console.log(JSON.stringify({ plan, check: !args["--no-check"] }, null, 2));
    return;
  }

  const user =
    process.env.NOTICE_SMTP_USER?.trim() ||
    (await ask("社区邮箱地址（比如 name@linux.do）："));
  if (!/^[^\s@<>"]+@linux\.do$/i.test(user))
    throw new Error("MAILBOX_INVALID: 要一个 @linux.do 的邮箱地址");
  const token =
    process.env.NOTICE_SMTP_TOKEN?.trim() ||
    (await askHidden("认证令牌（输入时不显示）："));
  if (!token || /\s/.test(token)) throw new Error("TOKEN_INVALID");
  const allowed = environments.includes("staging")
    ? await ask("Stage 只发给哪些 LINUX DO 数字 ID（逗号分隔）：")
    : "";
  if (
    environments.includes("staging") &&
    !/^[1-9]\d{0,18}(,[1-9]\d{0,18})*$/.test(allowed.replace(/\s/g, ""))
  )
    throw new Error("ALLOWED_IDS_INVALID: 填数字 ID，逗号分隔");

  if (!args["--no-check"]) {
    process.stdout.write(`登录 ${SMTP_HOST} 检查一下……`);
    const problem = await checkLogin(user, token);
    if (problem) {
      process.stdout.write("没通过\n");
      throw new Error(`SMTP_LOGIN_FAILED: ${problem}`);
    }
    process.stdout.write("通过\n");
  }

  const done: string[] = [];
  for (const environment of environments) {
    putSecret(environment, "NOTICE_SMTP_USER", user);
    putSecret(environment, "NOTICE_SMTP_TOKEN", token);
    done.push(
      `${environment}: NOTICE_SMTP_USER`,
      `${environment}: NOTICE_SMTP_TOKEN`,
    );
    if (environment === "staging") {
      putSecret(
        environment,
        "NOTICE_ALLOWED_LINUX_DO_IDS",
        allowed.replace(/\s/g, ""),
      );
      done.push("staging: NOTICE_ALLOWED_LINUX_DO_IDS");
    }
  }
  console.log(JSON.stringify({ done }, null, 2));
}

runMain(import.meta.url, main);
