import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBrowserUpdate } from "../src/services/browserUpdates.mjs";

const release = () => ({ tag_name: "v0.4.0", assets: [{ name: "Weave-Browser-v0.4.0.zip", size: 100, digest: `sha256:${"a".repeat(64)}`, browser_download_url: "https://github.com/soberbw-hash/Yingxiang/releases/download/v0.4.0/Weave-Browser-v0.4.0.zip" }] });
const response = value => async () => ({ ok: true, json: async () => value });

test("finds an official newer browser release and does not offer older releases", async () => {
  assert.equal((await checkBrowserUpdate("0.3.0", response(release()))).available, true);
  assert.equal((await checkBrowserUpdate("0.4.0", response(release()))).available, false);
  assert.equal((await checkBrowserUpdate("0.5.0", response(release()))).available, false);
});

test("rejects invalid or unsafe release assets", async () => {
  const bad = release();
  bad.assets[0].browser_download_url = "https://example.com/file.zip";
  await assert.rejects(checkBrowserUpdate("0.3.0", response(bad)), /官方发布地址/);
  bad.assets[0].digest = null;
  await assert.rejects(checkBrowserUpdate("0.3.0", response(bad)), /校验信息/);
  const preview = release(); preview.prerelease = true;
  await assert.rejects(checkBrowserUpdate("0.3.0", response(preview)), /正式版本/);
});
