import { describe, expect, it } from "vitest";
import { normalizeAvatarUrl, normalizeConnectEmail } from "../src/index";

describe("public avatar addresses", () => {
  it("preserves provider HTTPS paths without assuming an avatar host", () => {
    expect(
      normalizeAvatarUrl(
        " https://cdn.example.com/avatars/Alice.png?size=128 ",
      ),
    ).toBe("https://cdn.example.com/avatars/Alice.png?size=128");
  });

  it.each([
    undefined,
    null,
    {},
    "",
    "/avatar.png",
    "//example.com/avatar.png",
    "http://example.com/avatar.png",
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/>",
    "https://user:password@example.com/avatar.png",
    "https://example.com/ava\ntar.png",
    `https://example.com/${"a".repeat(2048)}`,
  ])("uses a local fallback for unsafe or absent values %#", (value) => {
    expect(normalizeAvatarUrl(value)).toBeNull();
  });
});

describe("optional Connect email", () => {
  it("preserves provider casing and aliases after trimming surrounding spaces", () => {
    expect(normalizeConnectEmail(" Alice+relay@example.com ")).toBe(
      "Alice+relay@example.com",
    );
  });

  it.each([
    undefined,
    null,
    {},
    "",
    "alice",
    "alice@example",
    "alice@example..com",
    "alice@example.com.",
    "<script>@example.com",
    "Alice <alice@example.com>",
    "alice@example.com\r\nBcc:other@example.com",
    `alice@${"a".repeat(320)}.com`,
  ])("does not save an invalid or absent address %#", (value) => {
    expect(normalizeConnectEmail(value)).toBeNull();
  });
});
