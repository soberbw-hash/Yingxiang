const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns").promises;
const net = require("node:net");
const path = require("node:path");
const MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
};
function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [168, 0, 2].includes(b)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && [18, 19, 51].includes(b)) ||
      (a === 203 && b === 0)
    );
  }
  return (
    net.isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:(db8|0):/i.test(address) &&
    !/^2002:/i.test(address)
  );
}
async function fetchRemote(
  { url },
  { maxBytes = 50 * 1024 * 1024, timeoutMs = 30000 } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const source = url;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const target = new URL(url);
      if (
        !["https:", "http:"].includes(target.protocol) ||
        target.username ||
        target.password
      )
        throw new Error("Only anonymous HTTP(S) URLs are supported");
      const host = target.hostname.replace(/^\[|\]$/g, "");
      const addresses = net.isIP(host)
        ? [{ address: host, family: net.isIP(host) }]
        : await dns.lookup(host, { all: true });
      if (controller.signal.aborted) throw new Error("Download timed out");
      if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
        throw new Error("Private network addresses are not allowed");
      const pinned = addresses[0];
      const result = await new Promise((resolve, reject) => {
        const request = (target.protocol === "https:" ? https : http).get(
          target,
          {
            signal: controller.signal,
            headers: {
              Accept: Object.keys(MIME).join(", "),
              "User-Agent": "Weave/1",
              "Accept-Encoding": "identity",
            },
            lookup: (_host, options, callback) =>
              callback(
                null,
                options.all ? [pinned] : pinned.address,
                pinned.family,
              ),
          },
          (response) => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
              response.resume();
              if (!response.headers.location)
                reject(new Error("Redirect missing location"));
              else
                resolve({
                  redirect: new URL(response.headers.location, target).href,
                });
              return;
            }
            if (response.statusCode < 200 || response.statusCode >= 300) {
              response.destroy();
              reject(new Error(`Download failed (${response.statusCode})`));
              return;
            }
            const mime = String(response.headers["content-type"] || "")
              .split(";")[0]
              .trim()
              .toLowerCase();
            if (
              !MIME[mime] ||
              (response.headers["content-encoding"] &&
                response.headers["content-encoding"] !== "identity")
            ) {
              response.destroy();
              reject(new Error("Response is not supported direct media"));
              return;
            }
            if (Number(response.headers["content-length"]) > maxBytes) {
              response.destroy();
              reject(new Error("Download exceeds size limit"));
              return;
            }
            const chunks = [];
            let size = 0;
            response.on("data", (chunk) => {
              size += chunk.length;
              if (size > maxBytes) {
                response.destroy(new Error("Download exceeds size limit"));
                return;
              }
              chunks.push(chunk);
            });
            response.on("error", reject);
            response.on("end", () => {
              let name;
              try {
                name = decodeURIComponent(path.posix.basename(target.pathname));
              } catch {
                name = "";
              }
              name = (name || "download")
                .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
                .slice(0, 200);
              const ext = MIME[mime];
              if (path.extname(name).toLowerCase() !== ext)
                name = `${path.parse(name).name}${ext}`;
              resolve({ name, bytes: [...Buffer.concat(chunks)], source });
            });
          },
        );
        request.on("error", reject);
      });
      if (!result.redirect) return result;
      url = result.redirect;
    }
    throw new Error("Too many redirects");
  } finally {
    clearTimeout(timer);
  }
}
module.exports = { fetchRemote, publicAddress };
