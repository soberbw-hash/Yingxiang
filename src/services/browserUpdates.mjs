const API = "https://api.github.com/repos/soberbw-hash/Yingxiang/releases/latest";
const MAX_BYTES = 512 * 1024 * 1024;

function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value || "");
  if (!match) throw new Error("发布版本号无效");
  const parts = match.slice(1).map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error("发布版本号无效");
  return parts;
}

export async function checkBrowserUpdate(currentVersion, fetchImpl = fetch) {
  const current = versionParts(currentVersion);
  const response = await fetchImpl(API, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`无法检查更新（GitHub ${response.status}）`);
  const release = await response.json();
  if (release.draft || release.prerelease) throw new Error("没有可用的正式版本");
  const latest = versionParts(release.tag_name);
  const version = latest.join(".");
  const comparison = latest.findIndex((part, index) => part !== current[index]);
  if (comparison < 0 || latest[comparison] < current[comparison]) return { available: false, version };
  const name = `Weave-Browser-v${version}.zip`;
  const asset = Array.isArray(release.assets) && release.assets.find(item => item.name === name);
  if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_BYTES || !/^sha256:[a-f\d]{64}$/i.test(asset.digest || ""))
    throw new Error("浏览器更新包尚未发布或缺少完整的校验信息");
  let url;
  try { url = new URL(asset.browser_download_url); } catch { throw new Error("更新包地址无效"); }
  if (url.protocol !== "https:" || url.host !== "github.com" || url.pathname !== `/soberbw-hash/Yingxiang/releases/download/v${version}/${name}` || url.search || url.hash)
    throw new Error("更新包地址不是官方发布地址");
  return { available: true, version, url: url.href, size: asset.size };
}
