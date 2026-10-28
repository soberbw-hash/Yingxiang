import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Script } from "node:vm";
import test from "node:test";
import {
  harmonyFonts,
  verifiedHarmonyFonts,
} from "../scripts/harmony-fonts.mjs";

const html = await readFile(
  new URL("../release/Weave-Browser/Weave.html", import.meta.url),
  "utf8",
);
test("browser deliverable is a self-contained HTML with no external startup dependencies", () => {
  assert.match(html, /<html lang="zh-CN">/);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(
    html,
    /<link\b[^>]*rel=["'](?:stylesheet|modulepreload)["']/i,
  );
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Script(scripts[0][1]));
  assert.doesNotMatch(
    html,
    /weave\.qa\.notification-directory|另一客户端新增 3 张角色|通知链路验收|拖入测试音频|实际拖拽已开始|音频拖放边界验收|audio-outbound-qa/,
  );
  // Keep the original app budget; full, unmodified offline fonts are additional.
  const fontSizes = [8261128, 8227312, 8158996];
  const embeddedFontBudget = fontSizes.reduce(
    (total, size) => total + 4 * Math.ceil(size / 3),
    0,
  );
  assert.ok(Buffer.byteLength(html) < embeddedFontBudget + 2_000_000);
});
test("browser deliverable includes local-storage warning and company-policy recovery text", () => {
  assert.match(html, /创建完整备份/);
  assert.match(html, /清理站点数据后，需要从完整备份恢复/);
  assert.match(html, /获批的 HTTPS 内网地址/);
  assert.match(html, /勿关闭安全防护/);
  assert.match(html, /开启浏览器通知/);
  assert.match(html, /发送测试通知/);
  assert.match(html, /软件内「通知」列表不受此权限影响/);
  assert.match(html, /接收目录更新时请保持页面打开/);
  assert.match(html, /用于上传/);
  assert.match(html, /下载原文件/);
  assert.match(html, /上沿对齐/);
  assert.ok(!html.includes("已准备文件"));
  assert.ok(html.includes("直接按住图片本身"));
  assert.ok(/\.asset-picture img\{[^}]*pointer-events:auto/.test(html));
});
test("browser package integrity marker matches the HTML and does not request an executable", async () => {
  const marker = JSON.parse(
    await readFile(
      new URL(
        "../release/Weave-Browser/.weave-browser-package.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(marker.format, "weave-browser-package");
  assert.equal(marker.executableRequired, false);
  assert.equal(marker.sha256, createHash("sha256").update(html).digest("hex"));
});
test("IT-hosted edition uses only relative external script and stylesheet files", async () => {
  const root = new URL("../release/Weave-Browser/内网部署/", import.meta.url);
  const page = await readFile(new URL("index.html", root), "utf8");
  const script = await readFile(new URL("app.js", root), "utf8");
  const css = await readFile(new URL("app.css", root), "utf8");
  assert.match(page, /<script src="\.\/app.js" defer><\/script>/);
  assert.match(page, /<link rel="stylesheet" href="\.\/app.css">/);
  assert.doesNotMatch(page, /<style>|<script>/);
  assert.doesNotThrow(() => new Script(script));
  assert.ok(css.includes(".asset-grid"));
  assert.ok(css.includes("./fonts/HarmonyOS_Sans_SC_Regular.ttf"));
  assert.ok(!css.includes("data:font/ttf"));
});

test("standalone HTML embeds unmodified official HarmonyOS fonts and retains their license", async () => {
  const embedded = [
    ...html.matchAll(/data:font\/ttf;base64,([A-Za-z0-9+/=]+)/g),
  ];
  assert.equal(embedded.length, 3);
  const hashes = embedded
    .map((match) =>
      createHash("sha256")
        .update(Buffer.from(match[1], "base64"))
        .digest("hex"),
    )
    .sort();
  assert.deepEqual(hashes, harmonyFonts.map((font) => font.sha256).sort());
  assert.ok(!html.includes("字体与许可"));
  assert.ok(!html.includes("project-initial"));
  const verified = await verifiedHarmonyFonts();
  const license = await readFile(
    new URL(
      "../release/Weave-Browser/HarmonyOS-Sans-LICENSE.txt",
      import.meta.url,
    ),
  );
  assert.deepEqual(license, verified.license);
  for (const font of verified.fonts) {
    const hosted = await readFile(
      new URL(
        `../release/Weave-Browser/内网部署/fonts/${font.name}`,
        import.meta.url,
      ),
    );
    assert.equal(
      createHash("sha256").update(hosted).digest("hex"),
      font.sha256,
    );
  }
});
