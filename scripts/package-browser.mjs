import { build } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import archiver from "archiver";
import { verifiedHarmonyFonts } from "./harmony-fonts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "release", "Weave-Browser");
const marker = path.join(target, ".weave-browser-package.json");
const typefaces = await verifiedHarmonyFonts();
try {
  const info = await fs.lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("输出路径不是普通目录");
  const previous = JSON.parse(await fs.readFile(marker, "utf8"));
  if (previous.format !== "weave-browser-package") throw new Error("拒绝覆盖非 Weave 浏览器交付目录");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  // If a directory exists without our marker, do not overwrite its files.
  const existing = await fs.readdir(target).catch(() => []);
  if (existing.length) throw new Error("浏览器交付目录已有未知文件，请另存后再构建");
}

const result = await build({
  root,
  configFile: false,
  publicDir: false,
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    write: false,
    emptyOutDir: false,
    target: "es2020",
    sourcemap: false,
    cssCodeSplit: false,
    lib: { entry: path.join(root, "src/main.tsx"), name: "WeaveBrowser", formats: ["iife"] },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output);
const chunks = outputs.filter((item) => item.type === "chunk");
if (chunks.length !== 1 || chunks[0].imports.length || chunks[0].dynamicImports.length)
  throw new Error("浏览器包必须只有一个自包含脚本");
const assets = outputs.filter((item) => item.type === "asset");
if (assets.some((asset) => !asset.fileName.endsWith(".css")))
  throw new Error("浏览器包出现外部资源，请改为内联后再构建");
const css = assets.map((asset) => String(asset.source)).join("\n");
if (/<\/style/i.test(css)) throw new Error("样式包含意外的 HTML 结束标签");
const javascript = chunks[0].code.replace(/<\/script/gi, "<\\/script");
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<title>映箱 · 浏览器本地版</title>
<link rel="icon" href="data:,">
<style>${css}</style>
</head>
<body>
<noscript>映箱需要 JavaScript。若公司策略限制，请联系 IT 审核，勿关闭安全防护。</noscript>
<div id="root"><p role="status">正在打开映箱…</p></div>
<script>${javascript}</script>
</body>
</html>`;
await fs.mkdir(target, { recursive: true });
await fs.writeFile(path.join(target, "Weave.html"), html);
const webDirectory = path.join(target, "内网部署");
try {
  const info = await fs.lstat(webDirectory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("内网部署输出路径不安全");
} catch (error) { if (error.code !== "ENOENT") throw error; }
await fs.mkdir(webDirectory, { recursive: true });
const fontDirectory = path.join(webDirectory, "fonts");
try {
  const info = await fs.lstat(fontDirectory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("字体输出路径不安全");
} catch (error) { if (error.code !== "ENOENT") throw error; }
await fs.mkdir(fontDirectory, { recursive: true });
let webCss = css;
for (const font of typefaces.fonts) {
  const embedded = `data:font/ttf;base64,${font.bytes.toString("base64")}`;
  if (!webCss.includes(embedded)) throw new Error(`浏览器包未内联字体：${font.name}`);
  webCss = webCss.replaceAll(embedded, `./fonts/${font.name}`);
  await fs.writeFile(path.join(fontDirectory, font.name), font.bytes);
}
await fs.writeFile(path.join(fontDirectory, "LICENSE.txt"), typefaces.license);
await fs.writeFile(path.join(target, "HarmonyOS-Sans-LICENSE.txt"), typefaces.license);
const webHtml = html
  .replace(`<style>${css}</style>`, '<link rel="stylesheet" href="./app.css">')
  .replace(`<script>${javascript}</script>`, '<script src="./app.js" defer></script>');
await fs.writeFile(path.join(webDirectory, "index.html"), webHtml);
await fs.writeFile(path.join(webDirectory, "app.js"), chunks[0].code);
await fs.writeFile(path.join(webDirectory, "app.css"), webCss);
await fs.copyFile(path.join(root, "docs/BROWSER-EDITION.md"), path.join(target, "使用说明.md"));
await fs.copyFile(path.join(root, "docs/EDITING-REFERENCE.md"), path.join(target, "剪辑对照-使用说明.md"));
await fs.writeFile(marker, JSON.stringify({
  format: "weave-browser-package",
  builtAt: new Date().toISOString(),
  sha256: createHash("sha256").update(html).digest("hex"),
  executableRequired: false,
  automaticUploads: false,
  bundledFonts: typefaces.fonts.map(({name, sha256}) => ({name, sha256})),
}, null, 2));
console.log(`浏览器交付：${path.join(target, "Weave.html")}（${Buffer.byteLength(html)} 字节）`);
console.log("仅在公司 IT 允许的浏览器环境或内网 HTTPS 站点使用，无需 Weave/Node 安装。");
if (process.argv.includes("--zip")) {
  const version = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version;
  const versioned = process.argv.includes("--versioned");
  if (versioned && !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("无法生成版本化的浏览器 ZIP：版本号无效。");
  const zip = path.join(root, "release", versioned ? `Weave-Browser-v${version}.zip` : "Weave-Browser.zip");
  try { await fs.access(zip); throw new Error("浏览器 ZIP 已存在，请先另存后再打包"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = path.join(root, "release", `.Weave-Browser-${randomUUID()}.zip`);
  await new Promise((resolve, reject) => {
    const output = createWriteStream(temporary, { flags: "wx" });
    const archive = archiver("zip", { zlib: { level: 6 } });
    const fail = (error) => { archive.abort(); output.destroy(); reject(error); };
    output.on("close", resolve);
    output.on("error", fail);
    archive.on("error", fail);
    archive.on("warning", fail);
    archive.pipe(output);
    for (const file of ["Weave.html", "使用说明.md", "剪辑对照-使用说明.md", ".weave-browser-package.json", "HarmonyOS-Sans-LICENSE.txt", "内网部署/index.html", "内网部署/app.js", "内网部署/app.css", "内网部署/fonts/LICENSE.txt", ...typefaces.fonts.map(({name}) => `内网部署/fonts/${name}`)])
      archive.file(path.join(target, file), { name: `Weave-Browser/${file}` });
    archive.finalize().catch(fail);
  });
  await fs.rename(temporary, zip);
  console.log(`浏览器交付压缩包：${zip}`);
}
