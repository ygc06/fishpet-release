import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/client.js", import.meta.url), "utf8");

test("desktop setup offers a domestic mirror before the GitHub fallback", () => {
  const mirror = source.indexOf(
    'var DESKTOP_SETUP_MIRROR_URL = "https://gh-proxy.com/" + DESKTOP_SETUP_URL',
  );
  const github = source.indexOf(
    'var DESKTOP_SETUP_URL = "https://github.com/ygc06/fishpet-release/releases/download/',
  );
  const mirrorButton = source.indexOf("⚡ 下载一键安装包");
  const githubButton = source.indexOf("\"GitHub 原站\"");

  assert.ok(mirror > 0, "expected a domestic mirror URL");
  assert.ok(github > 0, "expected the original GitHub asset URL");
  assert.ok(mirrorButton > 0, "expected the mirror action label");
  assert.ok(githubButton > mirrorButton, "GitHub should remain the explicit fallback");
});

test("desktop setup links the official checksum and does not auto-download", () => {
  assert.match(source, /var DESKTOP_CHECKSUM_URL = DESKTOP_SETUP_URL \+ "\.sha256"/);
  assert.match(source, /SHA-256/);
  assert.doesNotMatch(source, /location\.href\s*=\s*DESKTOP_SETUP_/);
  assert.doesNotMatch(source, /window\.open\(\s*DESKTOP_SETUP_/);
  assert.match(source, /onClick:\s*close/);
});

test("the plugin registers its detail-page download card and uses the mirror in the dashboard footer", () => {
  const slots = [...source.matchAll(/ctx\.slots\.inject\(\s*["']([^"']+)["']/g)]
    .map((match) => match[1]);
  assert.deepEqual(slots, ["plugins.detail.section", "shell.overlay"]);
  assert.match(source, /function PluginDownloadSection\(props\)/);
  assert.match(source, /subject\.kind !== "bundle" \|\| pkg\.name !== "@local\/dsh-fishpet-emotion"/);
  assert.match(source, /"⚡ 下载一键安装包（国内加速）"/);
  assert.match(source, /className:\s*"dfe-desktop-download",[\s\S]{0,160}href:\s*DESKTOP_SETUP_MIRROR_URL/);
});
