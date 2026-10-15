// Copied from apps/web/src/components/presentation/password-input.tsx
// (inspectPassword / optimizePassword). Importing that file would pull the
// production router, session and API client into the prototype. Extract both
// into src/lib/password-rules.ts when the redesign is promoted.

export type PasswordInspection = {
  invalidCount: number;
  length: number;
  valid: boolean;
  message: string | null;
};

export const allowedPasswordCharacter = /^[\p{Script=Han}A-Za-z0-9]$/u;

export function inspectPassword(raw: string): PasswordInspection {
  const characters = Array.from(raw);
  const length = characters.length;
  const invalidCount = characters.reduce(
    (count, character) =>
      count + Number(!allowedPasswordCharacter.test(character)),
    0,
  );
  const valid = invalidCount === 0 && length >= 6 && length <= 18;
  const messages: string[] = [];

  if (invalidCount > 0) {
    messages.push(`有 ${invalidCount} 个不可用字符，请修正红色标记。`);
  }
  if (length < 6) {
    messages.push(`还需 ${6 - length} 个字符，口令至少为 6 个字符。`);
  } else if (length > 18) {
    messages.push(`当前有 ${length} 个字符，口令最多为 18 个字符。`);
  }

  return { invalidCount, length, valid, message: messages.join(" ") || null };
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
