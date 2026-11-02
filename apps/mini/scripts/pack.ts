// dist/package/app.zip for the forum's sandbox (docs/mini-app-design.md §6):
// the five base files, packed by the forum's own SDK. That SDK is not in this
// repository: MINI_APP_SDK names its sdk/ folder (default: the downloaded
// kit). The id is manifest.json's, the one the forum's app page gave (public:
// it is in the app's address); MINI_APP_ID and MINI_APP_VERSION override it
// and the version.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const sdk =
  process.env.MINI_APP_SDK ??
  join(homedir(), "Downloads/discourse-mini-app-guidelines/sdk");
const { pack } = (await import(pathToFileURL(join(sdk, "pack.mjs")).href)) as {
  pack: (options: {
    manifest: unknown;
    files: Record<string, Uint8Array>;
    outputDirectory: string;
  }) => Promise<{ file: string; zipSha256: string; size: number }>;
};

const manifest = JSON.parse(await readFile("manifest.json", "utf8")) as {
  id: string;
  version: string;
};
manifest.id = process.env.MINI_APP_ID || manifest.id;
manifest.version = process.env.MINI_APP_VERSION || manifest.version;
const files = {
  "index.html": await readFile("src/template.html"),
  "app.js": await readFile("dist/web/app.js"),
  "app.css": await readFile("dist/web/app.css"),
  "strings.json": await readFile("src/strings.json"),
};
const result = await pack({ manifest, files, outputDirectory: "dist/package" });
console.log(
  `${result.file}：${result.size} 字节，应用 ${manifest.id}，版本 ${manifest.version}，SHA-256 ${result.zipSha256}`,
);
