const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");
const {
  compareVersions,
  detectManagedInstall,
  findChecksum,
  parseDesktopEntryVersion,
  parseVersionManifest,
  resolveInstallLayout,
  selectReleasesToPrune,
} = require("./updater-linux.cjs");

describe("compareVersions", () => {
  test("orders by major, minor, patch numerically", () => {
    assert.equal(compareVersions("0.6.7", "0.6.6"), 1);
    assert.equal(compareVersions("0.6.6", "0.6.7"), -1);
    assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
    assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
    assert.equal(compareVersions("0.6.10", "0.6.9"), 1);
  });

  test("equal versions compare as 0", () => {
    assert.equal(compareVersions("0.6.6", "0.6.6"), 0);
    assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.2"), 0);
  });

  test("a pre-release sorts below its release", () => {
    assert.equal(compareVersions("1.0.0-alpha", "1.0.0"), -1);
    assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
    assert.equal(compareVersions("1.0.1-alpha", "1.0.0"), 1);
  });

  test("follows the semver 2.0 pre-release precedence example", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      assert.equal(
        compareVersions(ordered[i], ordered[i + 1]),
        -1,
        `${ordered[i]} < ${ordered[i + 1]}`,
      );
      assert.equal(
        compareVersions(ordered[i + 1], ordered[i]),
        1,
        `${ordered[i + 1]} > ${ordered[i]}`,
      );
    }
  });

  test("ignores build metadata", () => {
    assert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0);
  });

  test("rejects anything that isn't semver", () => {
    for (const bad of [
      "",
      "1.0",
      "v1.0.0",
      "01.0.0",
      "1.0.0.0",
      "1.0.x",
      " 1.0.0",
    ]) {
      assert.throws(
        () => compareVersions(bad, "1.0.0"),
        /not a semver version/,
        bad,
      );
      assert.throws(
        () => compareVersions("1.0.0", bad),
        /not a semver version/,
        bad,
      );
    }
  });
});

describe("parseVersionManifest", () => {
  test("reads a version with surrounding whitespace", () => {
    assert.equal(parseVersionManifest("0.6.7\n"), "0.6.7");
    assert.equal(parseVersionManifest("  1.2.3-rc.1\r\n"), "1.2.3-rc.1");
  });

  test("rejects empty, garbled or HTML content", () => {
    for (const bad of [
      "",
      "\n",
      "v0.6.7",
      "0.6",
      "<!DOCTYPE html>",
      "0.6.7\n0.6.8",
      "1.0.0+meta",
    ]) {
      assert.throws(
        () => parseVersionManifest(bad),
        /no valid version/,
        JSON.stringify(bad),
      );
    }
  });
});

describe("findChecksum", () => {
  const hash = "a".repeat(64);
  const other = "b".repeat(64);

  test("finds the hash in sha256sum text and binary mode lines", () => {
    assert.equal(
      findChecksum({
        checksums: `${hash}  Qiraa-x86_64.AppImage\n`,
        fileName: "Qiraa-x86_64.AppImage",
      }),
      hash,
    );
    assert.equal(
      findChecksum({
        checksums: `${hash} *Qiraa-x86_64.AppImage`,
        fileName: "Qiraa-x86_64.AppImage",
      }),
      hash,
    );
  });

  test("picks the line for the requested file only", () => {
    const checksums = `${other}  Qiraa-0.6.7-x86_64.AppImage\r\n${hash}  Qiraa-x86_64.AppImage\r\n`;
    assert.equal(
      findChecksum({ checksums, fileName: "Qiraa-x86_64.AppImage" }),
      hash,
    );
    assert.equal(
      findChecksum({
        checksums: `${other}  xQiraa-x86_64.AppImage`,
        fileName: "Qiraa-x86_64.AppImage",
      }),
      null,
    );
  });

  test("lower-cases an upper-case hash", () => {
    assert.equal(
      findChecksum({ checksums: `${"A".repeat(64)}  f`, fileName: "f" }),
      hash,
    );
  });

  test("returns null for missing files and malformed lines", () => {
    assert.equal(findChecksum({ checksums: "", fileName: "f" }), null);
    assert.equal(
      findChecksum({ checksums: `${"a".repeat(63)}  f`, fileName: "f" }),
      null,
    );
    assert.equal(
      findChecksum({ checksums: `${"z".repeat(64)}  f`, fileName: "f" }),
      null,
    );
    assert.equal(findChecksum({ checksums: `${hash}f`, fileName: "f" }), null);
  });
});

describe("parseDesktopEntryVersion", () => {
  test("reads X-AppImage-Version", () => {
    const entry =
      "[Desktop Entry]\nName=رقمنة\nExec=AppRun\nX-AppImage-Version=0.6.6\n";
    assert.equal(parseDesktopEntryVersion(entry), "0.6.6");
  });

  test("returns null without the key", () => {
    assert.equal(parseDesktopEntryVersion("[Desktop Entry]\nName=x\n"), null);
  });
});

describe("selectReleasesToPrune", () => {
  test("after an update keeps the new current and the running release", () => {
    assert.deepEqual(
      selectReleasesToPrune({
        releases: ["0.6.4", "0.6.5", "0.6.6", "0.6.7"],
        current: "0.6.7",
        running: "0.6.6",
      }),
      ["0.6.4", "0.6.5"],
    );
  });

  test("keeps the running release even when it isn't the newest old one", () => {
    assert.deepEqual(
      selectReleasesToPrune({
        releases: ["0.6.4", "0.6.5", "0.6.6", "0.6.7"],
        current: "0.6.7",
        running: "0.6.4",
      }),
      ["0.6.5", "0.6.6"],
    );
  });

  test("when current is the running release, keeps the newest other version", () => {
    assert.deepEqual(
      selectReleasesToPrune({
        releases: ["0.9.0", "0.10.0", "0.6.6", "0.11.0"],
        current: "0.11.0",
        running: "0.11.0",
      }),
      ["0.9.0", "0.6.6"],
    );
  });

  test("prunes non-version entries and never keeps them as the fallback", () => {
    assert.deepEqual(
      selectReleasesToPrune({
        releases: ["junk", "0.6.6", "0.6.7"],
        current: "0.6.7",
        running: "0.6.7",
      }),
      ["junk"],
    );
    assert.deepEqual(
      selectReleasesToPrune({
        releases: ["junk", "0.6.7"],
        current: "0.6.7",
        running: "0.6.7",
      }),
      ["junk"],
    );
  });

  test("has nothing to prune with one or two releases", () => {
    assert.deepEqual(
      selectReleasesToPrune({
        releases: ["0.6.7"],
        current: "0.6.7",
        running: "0.6.7",
      }),
      [],
    );
    assert.deepEqual(
      selectReleasesToPrune({
        releases: ["0.6.6", "0.6.7"],
        current: "0.6.7",
        running: "0.6.6",
      }),
      [],
    );
  });
});

describe("install layout", () => {
  test("honours XDG_DATA_HOME and falls back to ~/.local/share", () => {
    assert.equal(
      resolveInstallLayout({ env: {}, homeDir: "/home/u" }).appDir,
      "/home/u/.local/share/qiraa-app",
    );
    assert.equal(
      resolveInstallLayout({
        env: { XDG_DATA_HOME: "/data" },
        homeDir: "/home/u",
      }).appDir,
      "/data/qiraa-app",
    );
    assert.equal(
      resolveInstallLayout({ env: {}, homeDir: "/home/u" }).launcher,
      "/home/u/.local/bin/qiraa-app",
    );
  });

  test("detects only a binary running from releases/<dir>/qiraa", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "qiraa-layout-"));
    try {
      const release = path.join(home, ".local/share/qiraa-app/releases/0.6.6");
      fs.mkdirSync(release, { recursive: true });
      fs.writeFileSync(path.join(release, "qiraa"), "");
      fs.symlinkSync(
        release,
        path.join(home, ".local/share/qiraa-app/current"),
      );
      const elsewhere = path.join(home, "opt/Qiraa");
      fs.mkdirSync(elsewhere, { recursive: true });
      fs.writeFileSync(path.join(elsewhere, "qiraa"), "");

      const viaCurrent = detectManagedInstall({
        execPath: path.join(home, ".local/share/qiraa-app/current/qiraa"),
        env: {},
        homeDir: home,
      });
      assert.equal(viaCurrent?.runningRelease, "0.6.6");
      assert.equal(
        detectManagedInstall({
          execPath: path.join(elsewhere, "qiraa"),
          env: {},
          homeDir: home,
        }),
        null,
      );
      assert.equal(
        detectManagedInstall({
          execPath: path.join(release, "qiraa"),
          env: { XDG_DATA_HOME: "/nowhere" },
          homeDir: home,
        }),
        null,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
