import { test } from "node:test";
import assert from "node:assert/strict";
import { publicAssetCategory, publicFolderCategory } from "../src/services/publicLibraryCategories.ts";

test("default folders join their category while other folders remain separate", () => {
  assert.equal(publicFolderCategory(" 产品 "), "product");
  assert.equal(publicAssetCategory({ group: "uncategorized", sourceFolder: "产品" }), "product");
  assert.equal(publicAssetCategory({ group: "character", sourceFolder: "未分类" }), "uncategorized");
  assert.equal(publicAssetCategory({ group: "prop", sourceFolder: "道具" }), "uncategorized");
  assert.equal(publicFolderCategory("NAS全系列产品"), undefined);
  assert.equal(publicAssetCategory({ group: "scene", sourceFolder: "NAS全系列产品" }), "scene");
});
