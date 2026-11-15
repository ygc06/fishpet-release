import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/client.js", import.meta.url), "utf8");
const checksum = "D4CAA179065B612F26005D95335CAAA73FAD92C63FCC5C7DB36DE19B86269DBA";

test("desktop setup offers a domestic mirror before the GitHub fallback", () => {
  const mirror = source.indexOf("https://gh-proxy.com/https://github.com/ygc06/fishpet-release/");
  const github = source.indexOf("https://github.com/ygc06/fishpet-release/releases/download/");
  const mirrorButton = source.indexOf("⚡ 国内加速下载");
  const githubButton = source.indexOf("\"GitHub 原站\"");

  assert.ok(mirror > 0, "expected a domestic mirror URL");
  assert.ok(github > 0, "expected the original GitHub asset URL");
  assert.ok(mirrorButton > 0, "expected the mirror action label");
  assert.ok(githubButton > mirrorButton, "GitHub should remain the explicit fallback");
});

test("desktop setup shows the release checksum and does not auto-download", () => {
  assert.match(source, new RegExp(`var DESKTOP_ZIP_SHA256 = "${checksum}"`));
  assert.match(source, /SHA-256/);
  assert.doesNotMatch(source, /location\.href\s*=\s*DESKTOP_ZIP_/);
  assert.doesNotMatch(source, /window\.open\(\s*DESKTOP_ZIP_/);
  assert.match(source, /onClick:\s*close/);
});

test("the plugin keeps its single overlay mount and uses the mirror in the dashboard footer", () => {
  const slots = [...source.matchAll(/ctx\.slots\.inject\(\s*["']([^"']+)["']/g)]
    .map((match) => match[1]);
  assert.deepEqual(slots, ["shell.overlay"]);
  assert.match(source, /className:\s*"dfe-desktop-download",[\s\S]{0,160}href:\s*DESKTOP_ZIP_MIRROR_URL/);
});
