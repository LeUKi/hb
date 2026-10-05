import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptString,
  digestPassword,
  encryptString,
} from "../src/security/crypto";
import {
  configuredAppOrigin,
  safeRelativeReturnTo,
} from "../src/security/http";

const key1 = btoa("12345678901234567890123456789012");
const key2 = btoa("abcdefghijklmnopqrstuvwxyz123456");
const secrets = {
  ENCRYPTION_KEYS: JSON.stringify({ first: key1, second: key2 }),
  ENCRYPTION_KEY_VERSION: "first",
};

afterEach(() => vi.restoreAllMocks());

function freshKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function encryptionEnv(key: string) {
  return {
    ENCRYPTION_KEYS: JSON.stringify({ current: key }),
    ENCRYPTION_KEY_VERSION: "current",
  };
}

describe("sensitive value protection", () => {
  it("reads an independently generated legacy v1 AES-GCM envelope after importing a cached key", async () => {
    const legacy = JSON.stringify({
      v: 1,
      alg: "AES-GCM",
      kid: "first",
      nonce: "AAECAwQFBgcICQoL",
      ciphertext: "NDEAexZytxrU6UdS5ppbNj2iaa4J81RBx2dHsnJ6kf8ENI4",
    });
    await encryptString("warm key", secrets, "other-purpose");
    expect(await decryptString(legacy, secrets, "legacy:reward")).toBe(
      "legacy-private-text",
    );
    await expect(
      decryptString(legacy, secrets, "other-purpose"),
    ).rejects.toThrow();
  });

  it("round-trips private text with fresh nonces and binds ciphertext to its purpose", async () => {
    const ciphertext = await encryptString(
      "专属兑换码 private123",
      secrets,
      "text-reward:inventory-1",
    );
    const second = await encryptString(
      "专属兑换码 private123",
      secrets,
      "text-reward:inventory-1",
    );
    expect(ciphertext).not.toBe(second);
    expect(ciphertext).not.toContain("private123");
    expect(
      await decryptString(ciphertext, secrets, "text-reward:inventory-1"),
    ).toBe("专属兑换码 private123");
    await expect(
      decryptString(ciphertext, secrets, "text-reward:inventory-2"),
    ).rejects.toThrow();
    await expect(
      decryptString(ciphertext, secrets, "password:inventory-1"),
    ).rejects.toThrow();
  });

  it("reads old values after rotation and rejects missing keys or tampering", async () => {
    const ciphertext = await encryptString("secret", secrets, "purpose");
    const rotated = { ...secrets, ENCRYPTION_KEY_VERSION: "second" };
    expect(await decryptString(ciphertext, rotated, "purpose")).toBe("secret");
    expect(
      JSON.parse(await encryptString("new secret", rotated, "purpose")).kid,
    ).toBe("second");
    await expect(
      decryptString(
        ciphertext,
        { ENCRYPTION_KEYS: JSON.stringify({ second: key2 }) },
        "purpose",
      ),
    ).rejects.toThrow();
    const damaged = JSON.parse(ciphertext);
    damaged.ciphertext = `${damaged.ciphertext[0] === "A" ? "B" : "A"}${damaged.ciphertext.slice(1)}`;
    await expect(
      decryptString(JSON.stringify(damaged), secrets, "purpose"),
    ).rejects.toThrow();
    await expect(
      encryptString("secret", { ENCRYPTION_KEYS: "{}" }, "purpose"),
    ).rejects.toThrow();
    await expect(
      encryptString(
        "secret",
        {
          ENCRYPTION_KEYS: JSON.stringify({ first: btoa("short") }),
          ENCRYPTION_KEY_VERSION: "first",
        },
        "purpose",
      ),
    ).rejects.toThrow();
  });

  it("uses keyed exact password indexes with case and character distinctions", async () => {
    const hash = await digestPassword("口令abc123", key1);
    expect(hash).toBe(await digestPassword("口令abc123", key1));
    expect(hash).not.toBe(await digestPassword("口令ABC123", key1));
    expect(hash).not.toBe(await digestPassword("口令abc123", key2));
    expect(hash).not.toContain("abc123");
    await expect(digestPassword("口令abc123", undefined)).rejects.toThrow();
    await expect(digestPassword("口令abc123", "weak")).rejects.toThrow();
  });
});

describe("bounded imported key reuse", () => {
  it("shares one in-flight AES import across bulk encryption and decryption without reusing nonces", async () => {
    const env = encryptionEnv(freshKey());
    const imported = vi.spyOn(crypto.subtle, "importKey");
    const ciphertexts = await Promise.all(
      Array.from({ length: 1000 }, (_, index) =>
        encryptString(`reward-${index}`, env, `inventory:${index}`),
      ),
    );
    expect(
      await Promise.all(
        ciphertexts.map((ciphertext, index) =>
          decryptString(ciphertext, env, `inventory:${index}`),
        ),
      ),
    ).toEqual(Array.from({ length: 1000 }, (_, index) => `reward-${index}`));
    expect(imported).toHaveBeenCalledOnce();
    const repeated = await encryptString("reward-0", env, "inventory:0");
    expect(JSON.parse(repeated).nonce).not.toBe(
      JSON.parse(ciphertexts[0] ?? "").nonce,
    );
    await expect(decryptString(repeated, env, "inventory:1")).rejects.toThrow();
  });

  it("shares HMAC imports while keeping algorithm and purpose separate from AES", async () => {
    const material = freshKey(),
      env = encryptionEnv(material);
    const imported = vi.spyOn(crypto.subtle, "importKey");
    const [ciphertext, digests] = await Promise.all([
      encryptString("private", env, "reward"),
      Promise.all(
        Array.from({ length: 20 }, () =>
          digestPassword("Correct123", material),
        ),
      ),
    ]);
    expect(new Set(digests).size).toBe(1);
    expect(await decryptString(ciphertext, env, "reward")).toBe("private");
    expect(imported).toHaveBeenCalledTimes(2);
  });

  it("isolates same-kid replacement material and concurrent environments", async () => {
    const first = encryptionEnv(freshKey()),
      second = encryptionEnv(freshKey());
    const imported = vi.spyOn(crypto.subtle, "importKey");
    const ciphertexts = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        encryptString("private", index % 2 ? first : second, "reward"),
      ),
    );
    for (const [index, ciphertext] of ciphertexts.entries()) {
      const correct = index % 2 ? first : second,
        other = index % 2 ? second : first;
      expect(await decryptString(ciphertext, correct, "reward")).toBe(
        "private",
      );
      await expect(
        decryptString(ciphertext, other, "reward"),
      ).rejects.toThrow();
      expect(JSON.parse(ciphertext).kid).toBe("current");
    }
    expect(imported).toHaveBeenCalledTimes(2);
  });

  it("does not use a cached historical key after the current key ring removes its kid", async () => {
    const first = encryptionEnv(freshKey());
    const ciphertext = await encryptString("private", first, "reward");
    const removed = {
      ENCRYPTION_KEYS: JSON.stringify({ replacement: freshKey() }),
    };
    await expect(decryptString(ciphertext, removed, "reward")).rejects.toThrow(
      "encryption key version is not configured",
    );
    expect(await decryptString(ciphertext, first, "reward")).toBe("private");
  });

  it("recovers after invalid AES or HMAC material is corrected", async () => {
    const invalid = encryptionEnv(btoa("short"));
    await expect(encryptString("private", invalid, "reward")).rejects.toThrow(
      "encryption keys must be 32 bytes",
    );
    await expect(digestPassword("Correct123", btoa("short"))).rejects.toThrow();
    const material = freshKey(),
      valid = encryptionEnv(material);
    const ciphertext = await encryptString("private", valid, "reward");
    expect(await decryptString(ciphertext, valid, "reward")).toBe("private");
    expect(await digestPassword("Correct123", material)).toMatch(/^v1:/);
  });

  it("evicts a failed import promise so the same configuration can recover", async () => {
    const env = encryptionEnv(freshKey());
    const imported = vi
      .spyOn(crypto.subtle, "importKey")
      .mockRejectedValueOnce(new Error("test-import-unavailable"));
    await expect(encryptString("private", env, "reward")).rejects.toThrow(
      "test-import-unavailable",
    );
    const ciphertext = await encryptString("private", env, "reward");
    expect(await decryptString(ciphertext, env, "reward")).toBe("private");
    expect(imported).toHaveBeenCalledTimes(2);
  });

  it("bounds retained historical imports and safely reimports an evicted key", async () => {
    const environments = Array.from({ length: 32 }, () =>
      encryptionEnv(freshKey()),
    );
    const first = environments[0];
    if (!first) throw new Error("Missing fixture");
    const imported = vi.spyOn(crypto.subtle, "importKey");
    const original = await encryptString("private", first, "reward");
    for (const env of environments.slice(1))
      await encryptString("private", env, "reward");
    expect(imported).toHaveBeenCalledTimes(32);
    expect(await decryptString(original, first, "reward")).toBe("private");
    expect(imported).toHaveBeenCalledTimes(33);
  });
});

describe("origin and return target validation", () => {
  it("requires a clean HTTPS origin except local loopback", () => {
    for (const APP_ORIGIN of [
      "https://hb.example.com",
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ]) {
      expect(configuredAppOrigin({ APP_ORIGIN })).toBe(APP_ORIGIN);
    }
    for (const APP_ORIGIN of [
      "http://hb.example.com",
      "https://hb.example.com/path",
      "https://user:pass@hb.example.com",
      "javascript:alert(1)",
      "not-a-url",
    ]) {
      expect(configuredAppOrigin({ APP_ORIGIN })).toBeNull();
    }
  });

  it("retains ordinary relative deep links", () => {
    expect(safeRelativeReturnTo("/account?tab=created#history")).toBe(
      "/account?tab=created#history",
    );
    expect(safeRelativeReturnTo(null)).toBe("/");
  });
});
