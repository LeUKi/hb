const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const importedKeyLimit = 8;
const importedKeys = new Map<string, Promise<CryptoKey>>();
let cachedKeyRing:
  | { encoded: string; keys: Record<string, string> }
  | undefined;

export type EncryptionEnvelope = {
  v: 1;
  alg: "AES-GCM";
  kid: string;
  nonce: string;
  ciphertext: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export async function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(value),
  );
  return hexEncode(new Uint8Array(digest));
}

export async function digestPassword(
  password: string,
  keyValue: string | undefined,
) {
  const key = await importHmacKey(keyValue, "password-digest");
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(`hb.password-digest.v1:${password}`),
  );
  return `v1:${base64UrlEncode(new Uint8Array(digest))}`;
}

export async function encryptString(
  plaintext: string,
  env: { ENCRYPTION_KEYS?: string; ENCRYPTION_KEY_VERSION?: string },
  associatedData: string,
): Promise<string> {
  const { keyVersion, key } = await currentEncryptionKey(env);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: textEncoder.encode(
        domainAssociatedData(associatedData, keyVersion),
      ),
    },
    key,
    textEncoder.encode(plaintext),
  );

  const envelope: EncryptionEnvelope = {
    v: 1,
    alg: "AES-GCM",
    kid: keyVersion,
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
  };

  return JSON.stringify(envelope);
}

export async function decryptString(
  envelopeValue: string,
  env: { ENCRYPTION_KEYS?: string },
  associatedData: string,
) {
  const envelope = parseEnvelope(envelopeValue);
  const key = await encryptionKeyByVersion(env, envelope.kid);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlDecode(envelope.nonce),
      additionalData: textEncoder.encode(
        domainAssociatedData(associatedData, envelope.kid),
      ),
    },
    key,
    base64UrlDecode(envelope.ciphertext),
  );

  return textDecoder.decode(plaintext);
}

async function importHmacKey(keyValue: string | undefined, purpose: string) {
  if (!keyValue) {
    throw new ConfigError(`${purpose} key is not configured`);
  }

  return cachedImport(
    JSON.stringify(["HMAC-SHA-256", purpose, keyValue]),
    () => {
      const rawKey = base64Decode(keyValue);
      if (rawKey.byteLength < 32) {
        throw new ConfigError(`${purpose} key must be at least 32 bytes`);
      }
      return crypto.subtle.importKey(
        "raw",
        rawKey,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    },
  );
}

async function currentEncryptionKey(env: {
  ENCRYPTION_KEYS?: string;
  ENCRYPTION_KEY_VERSION?: string;
}) {
  const keyVersion = env.ENCRYPTION_KEY_VERSION;
  if (!keyVersion) {
    throw new ConfigError("ENCRYPTION_KEY_VERSION is not configured");
  }

  const key = await encryptionKeyByVersion(env, keyVersion);
  return { keyVersion, key };
}

async function encryptionKeyByVersion(
  env: { ENCRYPTION_KEYS?: string },
  keyVersion: string,
) {
  const keyRing = parseKeyRing(env.ENCRYPTION_KEYS);
  if (!Object.hasOwn(keyRing, keyVersion)) {
    throw new ConfigError("encryption key version is not configured");
  }

  const keyValue = keyRing[keyVersion];
  if (typeof keyValue !== "string") {
    throw new ConfigError("encryption key must be a string");
  }

  if (!keyValue) {
    throw new ConfigError("encryption key version is not configured");
  }

  return cachedImport(JSON.stringify(["AES-GCM", keyValue]), () => {
    const rawKey = base64Decode(keyValue);
    if (rawKey.byteLength !== 32) {
      throw new ConfigError("encryption keys must be 32 bytes");
    }
    return crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  });
}

function cachedImport(cacheKey: string, importKey: () => Promise<CryptoKey>) {
  const cached = importedKeys.get(cacheKey);
  if (cached) return cached;
  // Cache the pending promise before callers await it, including bulk inventory
  // operations. Only imported keys are retained, never plaintext or ciphertext.
  const pending = importKey().catch((error: unknown) => {
    if (importedKeys.get(cacheKey) === pending) importedKeys.delete(cacheKey);
    throw error;
  });
  importedKeys.set(cacheKey, pending);
  if (importedKeys.size > importedKeyLimit) {
    const oldest = importedKeys.keys().next().value;
    if (oldest !== undefined) importedKeys.delete(oldest);
  }
  return pending;
}

function parseKeyRing(value: string | undefined) {
  if (!value) {
    throw new ConfigError("ENCRYPTION_KEYS is not configured");
  }
  if (cachedKeyRing?.encoded === value) return cachedKeyRing.keys;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConfigError("ENCRYPTION_KEYS must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError("ENCRYPTION_KEYS must be an object");
  }

  const keys = parsed as Record<string, string>;
  // One exact configuration snapshot keeps environments and rotations isolated.
  // Looking up the requested kid still happens before consulting importedKeys.
  cachedKeyRing = { encoded: value, keys };
  return keys;
}

function parseEnvelope(value: string): EncryptionEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid encrypted value");
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as EncryptionEnvelope).v !== 1 ||
    (parsed as EncryptionEnvelope).alg !== "AES-GCM" ||
    typeof (parsed as EncryptionEnvelope).kid !== "string" ||
    typeof (parsed as EncryptionEnvelope).nonce !== "string" ||
    typeof (parsed as EncryptionEnvelope).ciphertext !== "string"
  ) {
    throw new Error("Invalid encrypted value");
  }

  return parsed as EncryptionEnvelope;
}

function domainAssociatedData(value: string, keyVersion: string) {
  return `hb.aes-gcm.v1:${keyVersion}:${value}`;
}

function hexEncode(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value: string) {
  return base64Decode(value.replaceAll("-", "+").replaceAll("_", "/"));
}

function base64Decode(value: string) {
  const padded = value.padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
