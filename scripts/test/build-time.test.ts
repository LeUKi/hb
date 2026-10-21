import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTimeUnixSeconds,
  readBuildTimeUnixSeconds,
  versionFileSource,
} from "../../apps/web/build-time";
import { inspectBuildTime } from "../release";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("build timestamp provenance", () => {
  it("captures seconds at build start and honors only valid build values", () => {
    expect(buildTimeUnixSeconds(undefined, 1_791_217_236_499)).toBe(
      1_791_217_236,
    );
    expect(buildTimeUnixSeconds("1791217236", 1_900_000_000_000)).toBe(
      1_791_217_236,
    );
    for (const invalid of [
      "",
      "0",
      "-1",
      "01",
      "1.5",
      "NaN",
      "9007199254740992",
    ])
      expect(() => buildTimeUnixSeconds(invalid)).toThrow(
        "BUILD_TIMESTAMP_INVALID",
      );
  });

  it("rejects an absent or mismatching visible build marker", () => {
    expect(() => readBuildTimeUnixSeconds("<html></html>")).toThrow(
      "BUILD_TIMESTAMP_MARKER_INVALID",
    );
    expect(() =>
      readBuildTimeUnixSeconds(
        '<span id="build-stamp" data-build-unix-seconds="1791217236">build @ 1791217237</span>',
      ),
    ).toThrow("BUILD_TIMESTAMP_MARKER_INVALID");
  });

  it("compares the actual page marker with the candidate manifest", () => {
    const directory = mkdtempSync(join(tmpdir(), "hb-build-time-"));
    temporary.push(directory);
    mkdirSync(join(directory, "client"));
    writeFileSync(
      join(directory, "client/index.html"),
      '<span class="build-stamp" id="build-stamp" data-build-unix-seconds="1791217236">build @ 1791217236</span>',
    );
    // The build open pages compare themselves with must be this one.
    expect(() => inspectBuildTime(directory, 1_791_217_236)).toThrow(
      "RELEASE_VERSION_FILE_MISMATCH",
    );
    writeFileSync(
      join(directory, "client/version.json"),
      versionFileSource(1_791_217_235),
    );
    expect(() => inspectBuildTime(directory, 1_791_217_236)).toThrow(
      "RELEASE_VERSION_FILE_MISMATCH",
    );
    writeFileSync(
      join(directory, "client/version.json"),
      versionFileSource(1_791_217_236),
    );
    expect(inspectBuildTime(directory, 1_791_217_236)).toBe(1_791_217_236);
    expect(() => inspectBuildTime(directory, 1_791_217_237)).toThrow(
      "RELEASE_BUILD_TIMESTAMP_MISMATCH",
    );
  });
});
