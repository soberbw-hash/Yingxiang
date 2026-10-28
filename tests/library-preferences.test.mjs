import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLibraryPreferences,
  defaultLibraryPreferences,
  readLibraryPreferences,
  LIBRARY_PREFERENCES_KEY,
} from "../src/services/libraryPreferences.ts";
import { createRequire } from "node:module";
import { droppedMediaUrl } from "../src/services/assetDrop.ts";
import { originalTileSize } from "../src/services/libraryLayout.ts";
const require = createRequire(import.meta.url);
const { applicationMenuTemplate } = require("../electron/application-menu.cjs");

test("category URL drops only accept explicit HTTP media addresses", () => {
  const transfer = (uri) => ({
    getData: (type) => (type === "text/uri-list" ? uri : ""),
  });
  assert.equal(
    droppedMediaUrl(transfer("#comment\r\nhttps://example.test/image.png\r\n")),
    "https://example.test/image.png",
  );
  assert.equal(droppedMediaUrl(transfer("file:///private.png")), "");
  assert.equal(droppedMediaUrl(transfer("javascript:alert(1)")), "");
  assert.equal(droppedMediaUrl({ getData: (type) => type === "text/plain" ? "https://example.test/voice.mp3" : "" }), "https://example.test/voice.mp3");
});

test("library display defaults to square thumbnails and hover filenames", () => {
  assert.deepEqual(parseLibraryPreferences(null), {
    layout: "square",
    names: "hover",
    density: "small",
  });
  assert.deepEqual(
    parseLibraryPreferences("{broken"),
    defaultLibraryPreferences,
  );
  assert.deepEqual(
    parseLibraryPreferences('{"layout":"unknown","names":false}'),
    defaultLibraryPreferences,
  );
});
test("personal display preferences round-trip and ignore unknown fields", () => {
  assert.deepEqual(
    parseLibraryPreferences(
      JSON.stringify({
        layout: "original",
        names: "below",
        density: "small",
        injected: true,
      }),
    ),
    { layout: "original", names: "below", density: "small" },
  );
});

test("original-ratio layout follows the video's own orientation", () => {
  assert.equal(originalTileSize({ kind: "video", category: "other" }, 9 / 16), "compact");
  assert.equal(originalTileSize({ kind: "video", category: "other" }, 16 / 9), "wide");
  assert.equal(originalTileSize({ kind: "video", category: "other" }, 1), "compact");
});

test("display migration uses compact once, retains layout/names and leaves old preferences intact", () => {
  const saved = new Map([
    [
      "weave.library-display.v1",
      JSON.stringify({ layout: "original", names: "below", density: "normal" }),
    ],
  ]);
  assert.deepEqual(
    readLibraryPreferences((key) => saved.get(key) ?? null),
    { layout: "original", names: "below", density: "small" },
  );
  assert.equal(
    JSON.parse(saved.get("weave.library-display.v1")).density,
    "normal",
  );
  saved.set(LIBRARY_PREFERENCES_KEY, JSON.stringify({ density: "normal" }));
  assert.equal(
    readLibraryPreferences((key) => saved.get(key) ?? null).density,
    "normal",
  );
});

test("square image framing preserves top of frame and asset cards have a visible boundary", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.layout-square \.asset-picture img\s*\{\s*object-position: center top/,
  );
  assert.match(
    css,
    /\.asset-card\s*\{[^}]*border: 1px solid var\(--category-border/,
  );
  assert.match(
    css,
    /\.asset-picture img,\s*\.asset-picture video\s*\{[^}]*object-fit: contain/,
  );
});
test("every native menu item has an explicit Chinese label, including roles", () => {
  const template = applicationMenuTemplate();
  assert.deepEqual(
    template.map((item) => item.label),
    ["文件", "编辑", "视图", "窗口"],
  );
  const verify = (items) =>
    items.forEach((item) => {
      if (item.type !== "separator")
        assert.match(item.label, /[\u4e00-\u9fff]/);
      if (item.submenu) verify(item.submenu);
    });
  verify(template);
});
