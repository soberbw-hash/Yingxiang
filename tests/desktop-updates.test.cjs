const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { checkLatestRelease, compareVersions, downloadRelease, parseVersion } = require("../electron/update-service.cjs");

const bytes = Buffer.from("weave test zip payload");
const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
function response(body, { status = 200, url = "" } = {}) {
  return { ok: status >= 200 && status < 300, status, url, json: async () => body, body };
}
function release(version = "0.3.0", digest = `sha256:${sha256}`) {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    body: "修复和优化",
    assets: [{
      name: `Weave-Windows-v${version}.zip`,
      size: bytes.length,
      digest,
      browser_download_url: `https://github.com/soberbw-hash/Yingxiang/releases/download/v${version}/Weave-Windows-v${version}.zip`,
    }],
  };
}

test("compares supported release versions without accepting malformed versions", () => {
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  assert.equal(compareVersions("0.2.10", "0.2.9"), 1);
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
  assert.throws(() => compareVersions("latest", "0.2.0"), /版本号格式/);
});

test("checks a newer public GitHub release and validates the expected asset", async () => {
  const update = await checkLatestRelease({
    currentVersion: "0.2.0",
    fetchImpl: async (url) => {
      assert.equal(url, "https://api.github.com/repos/soberbw-hash/Yingxiang/releases/latest");
      return response(release());
    },
  });
  assert.equal(update.available, true);
  assert.equal(update.version, "0.3.0");
  assert.equal(update.sha256, sha256);
  assert.equal(update.notes, "修复和优化");
});

test("does not offer current, drafts, prereleases, or unverifiable packages", async () => {
  const current = await checkLatestRelease({ currentVersion: "0.3.0", fetchImpl: async () => response(release()) });
  assert.equal(current.available, false);
  const draft = release(); draft.draft = true;
  assert.equal((await checkLatestRelease({ currentVersion: "0.2.0", fetchImpl: async () => response(draft) })).available, false);
  await assert.rejects(checkLatestRelease({
    currentVersion: "0.2.0",
    fetchImpl: async () => response(release("0.3.0", null)),
  }), /SHA-256/);
});

test("downloads a release atomically and verifies size and SHA-256", async () => {
  const downloadsPath = await fs.mkdtemp(path.join(os.tmpdir(), "weave-update-test-"));
  try {
    const update = await checkLatestRelease({ currentVersion: "0.2.0", fetchImpl: async () => response(release()) });
    const result = await downloadRelease({
      update,
      downloadsPath,
      fetchImpl: async () => response(new ReadableStream({
        start(controller) { controller.enqueue(bytes); controller.close(); },
      }), { url: "https://release-assets.githubusercontent.com/asset" }),
    });
    assert.equal(result.sha256, sha256);
    assert.equal(await fs.readFile(result.path, "utf8"), bytes.toString());
    assert.equal((await fs.readdir(downloadsPath)).length, 1);
    const reused = await downloadRelease({ update, downloadsPath, fetchImpl: async () => assert.fail("verified local asset should be reused") });
    assert.equal(reused.alreadyPresent, true);
  } finally { await fs.rm(downloadsPath, { recursive: true, force: true }); }
});

test("rejects a corrupt payload and removes the partial file", async () => {
  const downloadsPath = await fs.mkdtemp(path.join(os.tmpdir(), "weave-update-test-"));
  try {
    const update = await checkLatestRelease({ currentVersion: "0.2.0", fetchImpl: async () => response(release()) });
    await assert.rejects(downloadRelease({
      update,
      downloadsPath,
      fetchImpl: async () => response(new ReadableStream({
        start(controller) { controller.enqueue(Buffer.from("bad")); controller.close(); },
      }), { url: "https://release-assets.githubusercontent.com/asset" }),
    }), /完整性校验/);
    assert.deepEqual(await fs.readdir(downloadsPath), []);
  } finally { await fs.rm(downloadsPath, { recursive: true, force: true }); }
});

test("rejects untrusted download domains and redirects", async () => {
  const update = { available: true, version: "0.3.0", assetName: "Weave-Windows-v0.3.0.zip", size: bytes.length, sha256, downloadUrl: "https://example.com/update.zip" };
  await assert.rejects(downloadRelease({ update, downloadsPath: os.tmpdir() }), /受信任/);
});
