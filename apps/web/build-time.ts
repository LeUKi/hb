import type { Plugin } from "vite";

export function buildTimeUnixSeconds(
  override = process.env.HB_BUILD_UNIX_SECONDS,
  now = Date.now(),
) {
  const seconds =
    override === undefined ? Math.floor(now / 1_000) : Number(override);
  if (
    (override !== undefined && !/^[1-9]\d*$/.test(override)) ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0
  )
    throw new Error("BUILD_TIMESTAMP_INVALID");
  return seconds;
}

export function buildTimePlugin(seconds: number): Plugin {
  return {
    name: "hb-build-time",
    transformIndexHtml() {
      return [
        {
          tag: "span",
          attrs: {
            id: "build-stamp",
            class: "build-stamp",
            "data-build-unix-seconds": String(seconds),
            "aria-label": "构建时间（Unix 秒）",
          },
          children: `build @ ${seconds}`,
          injectTo: "body",
        },
      ];
    },
  };
}

/**
 * /version.json: the build the page compares itself with, to offer a
 * reload after a release (docs/redesign/02-shell.md §8). The page's own
 * build stamp holds the same number.
 */
export function versionFilePlugin(seconds: number): Plugin {
  return {
    name: "hb-version-file",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: versionFileSource(seconds),
      });
    },
  };
}

export function versionFileSource(seconds: number) {
  return `${JSON.stringify({ build: seconds })}\n`;
}

export function readBuildTimeUnixSeconds(html: string) {
  const marker = html.match(
    /<span\b(?=[^>]*\bid="build-stamp")(?=[^>]*\bdata-build-unix-seconds="([1-9]\d*)")[^>]*>build @ ([1-9]\d*)<\/span>/,
  );
  if (!marker || marker[1] !== marker[2])
    throw new Error("BUILD_TIMESTAMP_MARKER_INVALID");
  return buildTimeUnixSeconds(marker[1]);
}
