// SMTP to the 社区's mail server (docs/notification-design.md §2.1): one
// session per batch over TLS on 465, AUTH PLAIN with the mailbox and its
// Mailu 认证令牌, then MAIL FROM / RCPT TO / DATA for each message. Plain
// text only, base64 so no line needs dot-stuffing.

export type SmtpAccount = {
  host: string;
  port: number;
  /** The mailbox, also the sender. */
  user: string;
  password: string;
  /** Names this side in EHLO and in Message-IDs. */
  domain: string;
  /** Shown before the address in From. */
  fromName: string;
};

export type Mail = { id: string; to: string; subject: string; text: string };

export type MailOutcome =
  | { id: string; ok: true }
  | { id: string; ok: false; permanent: boolean; reason: string };

export type SmtpConnection = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
};

const READ_TIMEOUT_MS = 20_000;
const encoder = new TextEncoder();

class SmtpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
  get permanent() {
    return this.code >= 500 && this.code < 600;
  }
}

class Session {
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;

  constructor(connection: SmtpConnection) {
    this.reader = connection.readable.getReader();
    this.writer = connection.writable.getWriter();
  }

  private async line(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf("\r\n");
      if (end >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return line;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SmtpError(0, "timeout")),
          READ_TIMEOUT_MS,
        );
      });
      try {
        const { value, done } = await Promise.race([
          this.reader.read(),
          timeout,
        ]);
        if (done) throw new SmtpError(0, "closed");
        this.buffer += this.decoder.decode(value, { stream: true });
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** A whole reply ("250-…" lines up to "250 …"). */
  async reply() {
    const lines: string[] = [];
    for (;;) {
      const line = await this.line();
      lines.push(line);
      if (!/^\d{3}-/.test(line)) break;
    }
    const last = lines.at(-1) ?? "";
    const code = Number(last.slice(0, 3));
    return { code: Number.isInteger(code) ? code : 0, text: lines.join(" ") };
  }

  async expect(accepted: number[]) {
    const { code, text } = await this.reply();
    if (!accepted.includes(code)) throw new SmtpError(code, text.slice(0, 200));
    return text;
  }

  async send(command: string, accepted: number[]) {
    await this.writer.write(encoder.encode(`${command}\r\n`));
    return this.expect(accepted);
  }

  async write(data: string) {
    await this.writer.write(encoder.encode(data));
  }
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

/** RFC 2047 words of at most 39 bytes each: a header line stays under 78. */
export function encodedWords(text: string) {
  const words: string[] = [];
  let chunk = "";
  for (const character of text) {
    if (encoder.encode(chunk + character).length > 39) {
      words.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) words.push(chunk);
  return words
    .map((word) => `=?UTF-8?B?${base64(encoder.encode(word))}?=`)
    .join("\r\n ");
}

function address(value: string) {
  // Never let a header break: the addresses come from Connect and config.
  if (!/^[^\s<>@"\r\n]+@[^\s<>@"\r\n]+$/.test(value))
    throw new SmtpError(553, "bad address");
  return value;
}

/** The message as sent after DATA, ending with the lone dot. */
export function messageOf(account: SmtpAccount, mail: Mail, at = new Date()) {
  const body = base64(encoder.encode(mail.text.replace(/\r?\n/g, "\r\n")))
    .match(/.{1,76}/g)
    ?.join("\r\n");
  return [
    `From: ${encodedWords(account.fromName)} <${address(account.user)}>`,
    `To: <${address(mail.to)}>`,
    `Subject: ${encodedWords(mail.subject)}`,
    `Date: ${at.toUTCString()}`,
    `Message-ID: <${mail.id}@${account.domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
    "",
    body ?? "",
    ".",
    "",
  ].join("\r\n");
}

async function openTls(account: SmtpAccount): Promise<SmtpConnection> {
  const { connect } = await import("cloudflare:sockets");
  const socket = connect(
    { hostname: account.host, port: account.port },
    { secureTransport: "on", allowHalfOpen: false },
  );
  await socket.opened;
  return socket;
}

/**
 * Sends each mail in one session. A mail the server turns down for good
 * (5xx) is permanent; anything else that stops a mail, including a session
 * that cannot start or breaks off, leaves it to be tried again.
 */
export async function sendMails(
  account: SmtpAccount,
  mails: Mail[],
  open: (account: SmtpAccount) => Promise<SmtpConnection> = openTls,
): Promise<MailOutcome[]> {
  const outcomes = new Map<string, MailOutcome>();
  const failRest = (reason: string, permanent = false) => {
    for (const mail of mails)
      if (!outcomes.has(mail.id))
        outcomes.set(mail.id, { id: mail.id, ok: false, permanent, reason });
  };
  let connection: SmtpConnection | undefined;
  try {
    connection = await open(account);
    const session = new Session(connection);
    await session.expect([220]);
    await session.send(`EHLO ${account.domain}`, [250]);
    const credentials = base64(
      encoder.encode(`\0${account.user}\0${account.password}`),
    );
    await session.send(`AUTH PLAIN ${credentials}`, [235]);
    for (const mail of mails) {
      try {
        await session.send(`MAIL FROM:<${address(account.user)}>`, [250]);
        await session.send(`RCPT TO:<${address(mail.to)}>`, [250, 251]);
        await session.send("DATA", [354]);
        await session.write(messageOf(account, mail));
        await session.expect([250]);
        outcomes.set(mail.id, { id: mail.id, ok: true });
      } catch (error) {
        if (!(error instanceof SmtpError) || error.code === 0) throw error;
        outcomes.set(mail.id, {
          id: mail.id,
          ok: false,
          permanent: error.permanent,
          reason: `smtp ${error.code}: ${error.message}`.slice(0, 200),
        });
        await session.send("RSET", [250]);
      }
    }
    await session.send("QUIT", [221]).catch(() => undefined);
  } catch (error) {
    failRest(
      error instanceof SmtpError
        ? `smtp ${error.code || error.message}: ${error.message}`.slice(0, 200)
        : "connection failed",
    );
  } finally {
    await connection?.close().catch(() => undefined);
  }
  return mails.map(
    (mail) =>
      outcomes.get(mail.id) ?? {
        id: mail.id,
        ok: false,
        permanent: false,
        reason: "not sent",
      },
  );
}
