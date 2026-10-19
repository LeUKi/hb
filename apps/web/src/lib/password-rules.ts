// 口令 rules as the 指令框 and the 发红包 form check them while typing (the
// API checks again: passwordSchema in @hb/contracts), and 优化, which turns
// a pasted 口令 into one that passes.
import { ACTIVITY_LIMITS } from "@hb/contracts";

export type PasswordInspection = {
  invalidCount: number;
  length: number;
  valid: boolean;
  message: string | null;
};

const { passwordMinCharacters: min, passwordMaxCharacters: max } =
  ACTIVITY_LIMITS;

export const allowedPasswordCharacter = /^[\p{Script=Han}A-Za-z0-9]$/u;

export function inspectPassword(raw: string): PasswordInspection {
  const characters = Array.from(raw);
  const length = characters.length;
  const invalidCount = characters.reduce(
    (count, character) =>
      count + Number(!allowedPasswordCharacter.test(character)),
    0,
  );
  const valid = invalidCount === 0 && length >= min && length <= max;
  const messages: string[] = [];

  if (invalidCount > 0) {
    messages.push(`有 ${invalidCount} 个不可用字符，请修正红色标记。`);
  }
  if (length < min) {
    messages.push(`还差 ${min - length} 个字，口令至少 ${min} 个字。`);
  } else if (length > max) {
    messages.push(`现在有 ${length} 个字，口令最多 ${max} 个字。`);
  }

  return { invalidCount, length, valid, message: messages.join("") || null };
}

export function optimizePassword(raw: string): string {
  return Array.from(raw, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint >= 0xff10 && codePoint <= 0xff19) ||
      (codePoint >= 0xff21 && codePoint <= 0xff3a) ||
      (codePoint >= 0xff41 && codePoint <= 0xff5a)
    ) {
      return String.fromCodePoint(codePoint - 0xfee0);
    }
    return character;
  })
    .filter((character) => allowedPasswordCharacter.test(character))
    .join("");
}
