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

export type Mail = {
  id: string;
  to: string;
  subject: string;
  text: string;
  /**
   * An HTML part beside the text, when given. The 社区 shows a mail's HTML
   * as source; with none it makes one of the text, showing it twice.
   */
  html?: string;
};

export type MailOutcome =
  | { id: string; ok: true; at: number }
  | { id: string; ok: false; permanent: boolean; reason: string }
  /**
   * Not tried: left for a later session (its turn came after `stopAt`, or
   * `onSent` stopped this one), with when its turn comes by the pace.
   */
  | { id: string; ok: false; due: number };

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

/** Base64 of UTF-8 text in lines of 76, CRLF line ends first. */
function base64Lines(text: string) {
  return (
    base64(encoder.encode(text.replace(/\r?\n/g, "\r\n")))
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? ""
  );
}

/** The message as sent after DATA, ending with the lone dot. */
export function messageOf(account: SmtpAccount, mail: Mail, at = new Date()) {
  const headers = [
    `From: ${encodedWords(account.fromName)} <${address(account.user)}>`,
    `To: <${address(mail.to)}>`,
    `Subject: ${encodedWords(mail.subject)}`,
    `Date: ${at.toUTCString()}`,
    `Message-ID: <${mail.id}@${account.domain}>`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
  ];
  const part = (type: string, text: string) => [
    `Content-Type: ${type}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(text),
  ];
  if (mail.html === undefined)
    return [...headers, ...part("text/plain", mail.text), ".", ""].join("\r\n");
  const boundary = `hb_${mail.id.replace(/[^A-Za-z0-9]/g, "")}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...part("text/plain", mail.text),
    `--${boundary}`,
    ...part("text/html", mail.html),
    `--${boundary}--`,
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
 * How far apart mails go (the 社区 drops mail that comes too close
 * together, Stage 2026-11-15): any two, two to one address, when each
 * address last got one before this session, and when anyone last did.
 */
export type MailPace = {
  anyGapMs: number;
  samePersonGapMs: number;
  lastSent?: ReadonlyMap<string, number>;
  /**
   * The last mail to anyone before this session: one session follows
   * another within a second when the queue has more (sweep 2026-11-21).
   */
  lastAny?: number;
};

/**
 * How long a session may go on, and who hears of each mail as it goes
 * (sweep 2026-11-21): a queue consumer is stopped at 15 minutes and its
 * whole batch delivered again.
 */
export type SessionLimits = {
  /** No mail starts after this (ms since 1970); the rest come back `due`. */
  stopAt?: number;
  /**
   * Hears of each mail that went out before the next one starts; false (or
   * a throw) stops the session there, the rest coming back `due`.
   */
  onSent?: (sent: { id: string; at: number }) => Promise<boolean>;
};

/**
 * Sends each mail in one session, logged in once the first is due. A mail
 * the server turns down for good (5xx) is permanent; anything else that
 * stops a mail, including a session that cannot start or breaks off, leaves
 * it to be tried again. One whose turn comes after `stopAt`, or after
 * `onSent` said stop, is not tried and comes back with when it is due.
 */
export async function sendMails(
  account: SmtpAccount,
  mails: Mail[],
  open: (account: SmtpAccount) => Promise<SmtpConnection> = openTls,
  pace: MailPace = { anyGapMs: 0, samePersonGapMs: 0 },
  limits: SessionLimits = {},
): Promise<MailOutcome[]> {
  const outcomes = new Map<string, MailOutcome>();
  const failRest = (reason: string, permanent = false) => {
    for (const mail of mails)
      if (!outcomes.has(mail.id))
        outcomes.set(mail.id, { id: mail.id, ok: false, permanent, reason });
  };
  let connection: SmtpConnection | undefined;
  try {
    let session: Session | undefined;
    const lastTo = new Map(pace.lastSent ?? []);
    let last = pace.lastAny ?? Number.NEGATIVE_INFINITY;
    let stopped = false;
    for (const mail of mails) {
      const due = Math.max(
        last + pace.anyGapMs,
        (lastTo.get(mail.to) ?? Number.NEGATIVE_INFINITY) +
          pace.samePersonGapMs,
        Date.now(),
      );
      if (stopped || due > (limits.stopAt ?? Number.POSITIVE_INFINITY)) {
        outcomes.set(mail.id, { id: mail.id, ok: false, due });
        continue;
      }
      const wait = due - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (!session) {
        // Only now: a run that leaves every mail for later logs in for none.
        connection = await open(account);
        session = new Session(connection);
        await session.expect([220]);
        await session.send(`EHLO ${account.domain}`, [250]);
        const credentials = base64(
          encoder.encode(`\0${account.user}\0${account.password}`),
        );
        await session.send(`AUTH PLAIN ${credentials}`, [235]);
      }
      try {
        await session.send(`MAIL FROM:<${address(account.user)}>`, [250]);
        await session.send(`RCPT TO:<${address(mail.to)}>`, [250, 251]);
        await session.send("DATA", [354]);
        await session.write(messageOf(account, mail));
        await session.expect([250]);
        last = Date.now();
        lastTo.set(mail.to, last);
        outcomes.set(mail.id, { id: mail.id, ok: true, at: last });
      } catch (error) {
        if (!(error instanceof SmtpError) || error.code === 0) throw error;
        outcomes.set(mail.id, {
          id: mail.id,
          ok: false,
          permanent: error.permanent,
          reason: `smtp ${error.code}: ${error.message}`.slice(0, 200),
        });
        await session.send("RSET", [250]);
        continue;
      }
      // Heard of before the next one starts: what went out is written down
      // before more can go.
      if (limits.onSent) {
        let goOn = false;
        try {
          goOn = await limits.onSent({ id: mail.id, at: last });
        } catch {}
        if (!goOn) stopped = true;
      }
    }
    await session?.send("QUIT", [221]).catch(() => undefined);
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
