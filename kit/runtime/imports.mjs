// What a judge.js imports, found without running it (协议第 4.3 节): static
// imports, re-exports and any dynamic import(). A small tokenizer skips
// strings, template literals, regular expressions and comments, so text in
// them is never taken for code. The sandbox has no network, no secrets and
// a virtual file system anyway; this check is so that the rules are plain.
import { LIMITS } from "./verdict.mjs";

export const ALLOWED_MODULES = Object.freeze([
  "node:crypto",
  "node:buffer",
  "node:util",
  "node:zlib",
  "node:path",
  "node:querystring",
  "node:string_decoder",
  "node:assert",
  "node:url",
  "node:events",
]);

// After these words a "/" starts a regular expression, not a division.
const BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);
const NAME_START = /[A-Za-z_$\u0080-￿]/;
const NAME_PART = /[\w$\u0080-￿]/;

function tokenize(source) {
  const tokens = [];
  const templates = []; // open `${`: braces seen inside each
  const length = source.length;
  let i = 0;

  const regexAllowed = () => {
    const previous = tokens[tokens.length - 1];
    if (!previous) return true;
    if (previous.type === "name") return BEFORE_REGEX.has(previous.value);
    if (previous.type === "punct")
      return !(
        previous.value === ")" ||
        previous.value === "]" ||
        previous.value === "}"
      );
    return false;
  };

  // From inside a template literal: to the closing ` or into a `${`.
  const readTemplate = (from) => {
    let j = from;
    while (j < length) {
      const char = source[j];
      if (char === "\\") j += 2;
      else if (char === "`") return j + 1;
      else if (char === "$" && source[j + 1] === "{") {
        templates.push(0);
        return j + 2;
      } else j += 1;
    }
    return length;
  };

  while (i < length) {
    const char = source[i];
    const next = source[i + 1];
    if (/\s/.test(char)) {
      i += 1;
    } else if (char === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? length : end;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? length : end + 2;
    } else if (char === '"' || char === "'") {
      let j = i + 1;
      let value = "";
      while (j < length && source[j] !== char && source[j] !== "\n") {
        if (source[j] === "\\") {
          value += source[j + 1] ?? "";
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ type: "string", value, at: i });
      i = j + 1;
    } else if (char === "`") {
      tokens.push({ type: "template", at: i });
      i = readTemplate(i + 1);
    } else if (
      char === "}" &&
      templates.length > 0 &&
      templates[templates.length - 1] === 0
    ) {
      templates.pop();
      tokens.push({ type: "template", at: i });
      i = readTemplate(i + 1);
    } else if (char === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < length && source[j] !== "\n") {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (inClass) {
          if (c === "]") inClass = false;
        } else if (c === "[") inClass = true;
        else if (c === "/") break;
        j += 1;
      }
      j += 1;
      while (j < length && /[a-z]/i.test(source[j])) j += 1;
      tokens.push({ type: "regex", at: i });
      i = j;
    } else if (NAME_START.test(char)) {
      let j = i + 1;
      while (j < length && NAME_PART.test(source[j])) j += 1;
      tokens.push({ type: "name", value: source.slice(i, j), at: i });
      i = j;
    } else if (
      /[0-9]/.test(char) ||
      (char === "." && /[0-9]/.test(next ?? ""))
    ) {
      let j = i + 1;
      while (j < length && /[\w.]/.test(source[j])) j += 1;
      tokens.push({ type: "number", at: i });
      i = j;
    } else {
      let value = char;
      if (char === "?" && next === ".") value = "?.";
      else if (char === "." && next === "." && source[i + 2] === ".")
        value = "...";
      if (templates.length > 0) {
        if (value === "{") templates[templates.length - 1] += 1;
        else if (value === "}") templates[templates.length - 1] -= 1;
      }
      tokens.push({ type: "punct", value, at: i });
      i += value.length;
    }
  }
  return tokens;
}

const isPunct = (token, value) =>
  token?.type === "punct" && token.value === value;

/** The string after `from` in this statement, if any. */
function fromClause(tokens, start) {
  for (let j = start; j < tokens.length && j < start + 500; j += 1) {
    if (isPunct(tokens[j], ";")) return null;
    if (
      tokens[j].type === "name" &&
      tokens[j].value === "from" &&
      tokens[j + 1]?.type === "string"
    )
      return tokens[j + 1];
  }
  return null;
}

/** The token after the ")" that closes the "(" at `open`. */
function afterParens(tokens, open) {
  let depth = 0;
  for (let j = open; j < tokens.length; j += 1) {
    if (isPunct(tokens[j], "(")) depth += 1;
    else if (isPunct(tokens[j], ")")) {
      depth -= 1;
      if (depth === 0) return tokens[j + 1];
    }
  }
  return undefined;
}

/**
 * Every import in a file: `{ kind: "static", specifier, at }` or
 * `{ kind: "dynamic", at }` (`at` is the character offset).
 */
export function scanImports(source) {
  const tokens = tokenize(source);
  const found = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== "name") continue;
    if (isPunct(tokens[i - 1], ".") || isPunct(tokens[i - 1], "?.")) continue;
    const next = tokens[i + 1];
    if (token.value === "import") {
      if (isPunct(next, "(")) {
        // A method called import() is followed by its body.
        if (!isPunct(afterParens(tokens, i + 1), "{"))
          found.push({ kind: "dynamic", at: token.at });
      } else if (isPunct(next, ".")) {
        // import.meta
      } else if (next?.type === "string") {
        found.push({ kind: "static", specifier: next.value, at: token.at });
      } else {
        const from = fromClause(tokens, i + 1);
        if (from)
          found.push({ kind: "static", specifier: from.value, at: token.at });
      }
    } else if (
      token.value === "export" &&
      (isPunct(next, "*") || isPunct(next, "{"))
    ) {
      const from = fromClause(tokens, i + 1);
      if (from)
        found.push({ kind: "static", specifier: from.value, at: token.at });
    }
  }
  return found;
}

const CLOSERS = { "(": ")", "[": "]", "{": "}" };

/** How many arguments the call whose "(" is at `open` has. */
function argumentCount(tokens, open) {
  const stack = [];
  let count = 0;
  let filled = false;
  for (let j = open; j < tokens.length; j += 1) {
    const token = tokens[j];
    if (token.type === "punct" && CLOSERS[token.value]) {
      stack.push(CLOSERS[token.value]);
      if (stack.length === 1) continue;
    } else if (token.type === "punct" && token.value === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return count + Number(filled);
    } else if (stack.length === 1 && isPunct(token, ",")) {
      count += Number(filled);
      filled = false;
      continue;
    }
    filled = true;
  }
  return count + Number(filled);
}

/** Each money function and the arguments it takes before n (protocol 5). */
const COUNTED = {
  even: { before: 0, example: "even(10)" },
  lucky: { before: 1, example: 'lucky("double", 10)' },
};

/**
 * Where judge.js calls tools.money.even() or lucky() without n (protocol
 * 5, docs/multi-prize-design.md §3.5): `{ line, message }` each, a
 * reminder that the pool is then shared about 1 LDC a share.
 */
export function uncountedShares(source) {
  const tokens = tokenize(source);
  const found = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    const counted =
      token.type === "name" && Object.hasOwn(COUNTED, token.value)
        ? COUNTED[token.value]
        : null;
    if (!counted) continue;
    if (!isPunct(tokens[i - 1], ".") && !isPunct(tokens[i - 1], "?.")) continue;
    if (!isPunct(tokens[i + 1], "(")) continue;
    if (argumentCount(tokens, i + 1) > counted.before) continue;
    found.push({
      line: lineOf(source, token.at),
      message: `${token.value}() 没传 n：按总奖池分，每份约 1 LDC；要分成几份就写 ${counted.example}`,
    });
  }
  return found;
}

function lineOf(source, at) {
  let line = 1;
  for (let i = 0; i < at; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

/** What breaks the rules in a judge.js, as `{ line, message }`, before it is ever run. */
export function checkSource(source) {
  const problems = [];
  if (new TextEncoder().encode(source).length > LIMITS.codeBytes)
    problems.push({
      line: 1,
      message: `代码超过 ${LIMITS.codeBytes / 1024} KB`,
    });
  for (const found of scanImports(source)) {
    const line = lineOf(source, found.at);
    if (found.kind === "dynamic") {
      problems.push({
        line,
        message: "不能用动态 import()，只能在文件开头静态 import",
      });
      continue;
    }
    const { specifier } = found;
    if (ALLOWED_MODULES.includes(specifier)) continue;
    let message;
    if (ALLOWED_MODULES.includes(`node:${specifier}`))
      message = `要写成 import … from "node:${specifier}"`;
    else if (specifier.startsWith("node:"))
      message = `${specifier} 不在能用的模块里，能用的是 ${ALLOWED_MODULES.join("、")}`;
    else if (specifier.startsWith(".") || specifier.startsWith("/"))
      message = `不能 import 别的文件（${specifier}），代码只能是一个文件`;
    else if (/^[a-z][a-z0-9+.-]*:/i.test(specifier))
      message = `不能 import 网址（${specifier}）`;
    else
      message = `不能 import npm 包（${specifier}），要用的部分放进 judge.js`;
    problems.push({ line, message });
  }
  return problems;
}
