import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesSearch } from "../src/services/workspaceSearch.ts";

test("search matches all words across names, notes and source folders without requiring phrase order", () => {
  assert.equal(matchesSearch("夜景 主角", "主角参考图.png", "城市夜景"), true);
  assert.equal(matchesSearch("夜景 主角", "主角参考图.png", "室内"), false);
  assert.equal(matchesSearch("SCENE\tNAS", "scene.png", undefined, "NAS 产品"), true);
});

test("empty or whitespace-only queries keep items and missing fields are harmless", () => {
  assert.equal(matchesSearch("   \n ", undefined), true);
  assert.equal(matchesSearch("视频", undefined, ""), false);
  assert.equal(matchesSearch("  开场 \n A  ", "开场版本 a.mp4"), true);
});
