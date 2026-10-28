import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifiedHarmonyFonts } from "../scripts/harmony-fonts.mjs";

test("bundled fonts and license retain original official bytes", async () => {
  const { fonts, license } = await verifiedHarmonyFonts();
  assert.equal(fonts.length, 3);
  for (const font of fonts) {
    assert.equal(font.bytes.readUInt32BE(0), 0x00010000);
    assert.ok(font.bytes.length > 8_000_000);
  }
  assert.ok(
    license.toString("utf8").includes("Copyright 2021 Huawei Device Co., Ltd."),
  );
});

test("UI, dialog, shortcut and storyboard labels share HarmonyOS typography without project avatar", async () => {
  const source = async (name) =>
    readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
  const [main, app, css, typography, features, settings, storyboard] =
    await Promise.all(
      [
        "main.tsx",
        "App.tsx",
        "styles.css",
        "typography.css",
        "features/features.css",
        "features/SettingsDialog.tsx",
        "services/storyboard.ts",
      ].map(source),
    );
  assert.ok(main.includes('import "./typography.css"'));
  assert.equal((typography.match(/@font-face/g) || []).length, 3);
  assert.ok(css.includes("font-family: var(--font-ui)"));
  assert.ok(features.includes("font-family: var(--font-ui)"));
  assert.ok(!app.includes("project-initial"));
  assert.ok(!css.includes("project-initial"));
  assert.match(
    app,
    /<strong>\{projectLabel\(snapshot\?\.project\) \|\| "创建一个项目"\}<\/strong>/,
  );
  assert.ok(!settings.includes("字体与许可"));
  assert.ok(storyboard.includes("document.fonts.load"));
  assert.ok(
    storyboard.includes(
      "ctx.font = '400 24px \"Weave HarmonyOS Sans\", sans-serif'",
    ),
  );
  assert.ok(!css.includes("Segoe UI"));
  assert.ok(!storyboard.includes("Microsoft YaHei"));
});
