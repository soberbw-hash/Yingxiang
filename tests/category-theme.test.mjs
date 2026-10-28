import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { categories, matchesCategory } from "../src/types.ts";
import {
  assetCategoryThemes,
  assetCategoryTheme,
  assetCategoryStyle,
} from "../src/services/assetCategoryTheme.ts";

const expected = {
  uncategorized: ["未分类", "灰"],
  product: ["产品", "蓝紫"],
  character: ["角色", "紫"],
  scene: ["场景", "绿"],
  prop: ["道具", "金棕"],
  storyboard: ["分镜", "蓝"],
  script: ["脚本", "玫瑰"],
  video: ["视频", "青蓝"],
  audio: ["音频", "橙棕"],
  other: ["其他", "石板"],
};

test("every category has a distinct semantic palette", () => {
  assert.deepEqual(
    Object.keys(assetCategoryThemes).sort(),
    Object.keys(expected).sort(),
  );
  const themes = Object.values(assetCategoryThemes);
  assert.equal(new Set(themes.map((theme) => theme.ink)).size, themes.length);
  for (const [id, theme] of Object.entries(assetCategoryThemes)) {
    assert.deepEqual([theme.label, theme.color], expected[id]);
    for (const color of [theme.ink, theme.background, theme.border])
      assert.match(color, /^#[0-9A-F]{6}$/);
    if (id === "prop") continue; // Legacy props are presented as unclassified.
    assert.deepEqual(assetCategoryStyle(id), {
      "--category-ink": theme.ink,
      "--category-bg": theme.background,
      "--category-border": theme.border,
    });
  }
});

test("legacy props are visible under unclassified without changing their records", () => {
  const asset = { kind: "image", category: "prop" };
  assert.equal(matchesCategory(asset, "uncategorized"), true);
  assert.equal(assetCategoryTheme("prop"), assetCategoryThemes.uncategorized);
  assert.equal(asset.category, "prop");
  assert.equal(categories.some(c => c.id === "prop"), false);
});

test("audio includes legacy originals while Other remains distinct from Unclassified", () => {
  assert.equal(
    categories.find((category) => category.id === "audio").label,
    "音频",
  );
  assert.equal(
    categories.find((category) => category.id === "other").label,
    "其他",
  );
  assert.equal(
    matchesCategory({ kind: "audio", category: "uncategorized" }, "audio"),
    true,
  );
  assert.equal(
    matchesCategory({ kind: "image", category: "other" }, "uncategorized"),
    false,
  );
  assert.equal(
    matchesCategory({ kind: "image", category: "uncategorized" }, "other"),
    false,
  );
});

test("six useful category destinations retain props and use balanced arrow-free layouts", async () => {
  const destinations = await readFile(
    new URL("../src/components/CategoryDestinations.tsx", import.meta.url),
    "utf8",
  );
  const css = await readFile(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  for (const id of [
    "character",
    "scene",
    "prop",
    "video",
    "audio",
    "other",
  ])
    assert.match(destinations, new RegExp(`id: "${id}"`));
  assert.doesNotMatch(destinations, /ArrowUpRight|category-enter/);
  assert.doesNotMatch(css, /\.category-enter/);
  assert.match(css, /\.category-destinations\s*\{[^}]*repeat\(6,/);
  assert.match(
    css,
    /@media \(max-width: 1400px\)[\s\S]*?\.category-destinations\s*\{[^}]*repeat\(6,/,
  );
});

function luminance(hex) {
  const channels = hex
    .slice(1)
    .match(/../g)
    .map((value) => {
      const srgb = parseInt(value, 16) / 255;
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(a, b) {
  const levels = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (levels[0] + 0.05) / (levels[1] + 0.05);
}

test("category labels and white selection checks meet 4.5:1 contrast", () => {
  for (const [id, theme] of Object.entries(assetCategoryThemes)) {
    assert.ok(
      contrast(theme.ink, theme.background) >= 4.5,
      `${id} label on tint`,
    );
    assert.ok(
      contrast(theme.ink, "#FFFFFF") >= 4.5,
      `${id} label on white and white check`,
    );
  }
});

test("unknown or future categories safely use gray without changing metadata", () => {
  for (const category of ["future", "all", "__proto__", "constructor", ""]) {
    assert.equal(
      assetCategoryTheme(category),
      assetCategoryThemes.uncategorized,
    );
    assert.deepEqual(
      assetCategoryStyle(category),
      assetCategoryStyle("uncategorized"),
    );
  }
});

test("cards, destinations and tabs share category tokens; selection is not color-only", async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const [card, destinations, view, css] = await Promise.all([
    read("../src/components/AssetThumb.tsx"),
    read("../src/components/CategoryDestinations.tsx"),
    read("../src/components/AssetsView.tsx"),
    read("../src/styles.css"),
  ]);
  assert.match(card, /style=\{assetCategoryStyle\(asset.category\)\}/);
  assert.match(
    card,
    /aria-description=\{`\$\{assetCategoryTheme\(asset.category\).label\}素材`\}/,
  );
  assert.match(card, /selected && <Check/);
  assert.match(card, /aria-pressed=\{selected\}/);
  assert.match(destinations, /style=\{assetCategoryStyle\(id\)\}/);
  assert.match(
    view,
    /c.id === "all" \? undefined : assetCategoryStyle\(c.id\)/,
  );
  assert.match(
    css,
    /\.asset-card.selected\s*\{[^}]*box-shadow: 0 0 0 1px var\(--category-ink/,
  );
  assert.match(
    css,
    /\.asset-card:focus-visible,[\s\S]*?outline: 2px solid var\(--category-ink/,
  );
  assert.doesNotMatch(
    css,
    /\.category-(scene|prop|storyboard|script|video)\s*\{/,
  );
});
