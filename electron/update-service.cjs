const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const OWNER = "soberbw-hash";
const REPOSITORY = "Yingxiang";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value || ""));
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error("更新版本号格式无效");
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

async function checkLatestRelease({ fetchImpl = fetch, currentVersion }) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${OWNER}/${REPOSITORY}/releases/latest`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    if (response.status === 404) return { available: false, currentVersion, unpublished: true };
    throw new Error(`检查更新失败（GitHub ${response.status}）`);
  }
  const release = await response.json();
  if (release.draft || release.prerelease) return { available: false, currentVersion };
  const version = String(release.tag_name || "").replace(/^v/, "");
  if (compareVersions(version, currentVersion) <= 0)
    return { available: false, currentVersion, latestVersion: version };

  const asset = (release.assets || []).find((item) =>
    new RegExp(`^Weave-Windows-v${version.replaceAll(".", "\\.")}\\.zip$`, "i").test(item.name),
  );
  if (!asset) throw new Error(`版本 ${version} 的 Windows ZIP 尚未发布`);
  const digest = /^sha256:([a-f\d]{64})$/i.exec(asset.digest || "");
  if (!digest) throw new Error("更新包缺少 SHA-256 校验信息，已停止下载");
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ARCHIVE_BYTES)
    throw new Error("更新包大小无效或超过 512 MB 安全上限");
  let url;
  try { url = new URL(asset.browser_download_url); }
  catch { throw new Error("更新下载地址无效"); }
  if (url.protocol !== "https:" || url.hostname !== "github.com")
    throw new Error("更新地址不是受信任的 GitHub HTTPS 地址");

  return {
    available: true,
    currentVersion,
    version,
    notes: String(release.body || "").slice(0, 8000),
    assetName: asset.name,
    size: asset.size,
    sha256: digest[1].toLowerCase(),
    downloadUrl: url.href,
  };
}

async function downloadRelease({ update, downloadsPath, fetchImpl = fetch }) {
  if (!update?.available || !/^Weave-Windows-v\d+\.\d+\.\d+\.zip$/i.test(update.assetName || ""))
    throw new Error("没有可下载的有效更新");
  if (!/^[a-f\d]{64}$/i.test(update.sha256 || "") || !Number.isSafeInteger(update.size) || update.size <= 0 || update.size > MAX_ARCHIVE_BYTES)
    throw new Error("更新校验信息无效");
  const url = new URL(update.downloadUrl);
  if (url.protocol !== "https:" || url.hostname !== "github.com")
    throw new Error("更新地址不是受信任的 GitHub HTTPS 地址");
  await fs.mkdir(downloadsPath, { recursive: true });
  const destination = path.join(downloadsPath, update.assetName);
  const temporary = path.join(downloadsPath, `.weave-update-${randomUUID()}.part`);
  try {
    try {
      const existing = await fs.readFile(destination);
      const hash = crypto.createHash("sha256").update(existing).digest("hex");
      if (existing.length === update.size && hash === update.sha256)
        return { path: destination, size: existing.length, sha256: hash, alreadyPresent: true };
    } catch (error) { if (error.code !== "ENOENT") throw error; }

    const response = await fetchImpl(url.href, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`下载更新失败（HTTP ${response.status}）`);
    const finalUrl = new URL(response.url || url.href);
    if (finalUrl.protocol !== "https:" || !["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(finalUrl.hostname))
      throw new Error("GitHub 将更新重定向到了不受信任的地址");

    const handle = await fs.open(temporary, "wx");
    const hash = crypto.createHash("sha256");
    let written = 0;
    try {
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        written += bytes.length;
        if (written > update.size || written > MAX_ARCHIVE_BYTES)
          throw new Error("更新下载大小超过发布清单");
        hash.update(bytes);
        await handle.write(bytes);
      }
      await handle.sync();
    } finally { await handle.close(); }
    const actualHash = hash.digest("hex");
    if (written !== update.size || actualHash !== update.sha256)
      throw new Error("更新包完整性校验失败，未保留下载文件");

    let finalPath = destination;
    try { await fs.access(finalPath); finalPath = path.join(downloadsPath, `Weave-Windows-v${update.version}-${actualHash.slice(0, 8)}.zip`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await fs.rename(temporary, finalPath);
    return { path: finalPath, size: written, sha256: actualHash, alreadyPresent: false };
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { MAX_ARCHIVE_BYTES, checkLatestRelease, compareVersions, downloadRelease, parseVersion };
