const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const read = (file) => readFileSync(path.resolve(__dirname, "..", file), "utf8");

test("desktop native asset drag resolves the original managed file in the main process", () => {
  const main = read("electron/main.cjs");
  const preload = read("electron/preload.cjs");
  const outbound = read("src/services/assetOutbound.ts");
  assert.match(preload, /startAssetDrag\(projectId, assetId\)[\s\S]*?ipcRenderer\.send\("weave:drag-asset"/);
  assert.match(main, /ipcMain\.on\("weave:drag-asset"[\s\S]*?trusted\(event\)[\s\S]*?repo\.resolveAsset\(\{\s*projectId: payload\.projectId,\s*id: payload\.assetId/);
  assert.match(main, /event\.sender\.startDrag\(\{\s*file,\s*icon:/);
  assert.match(outbound, /if \(!bridge \|\| !projectId\) return false;[\s\S]*?event\.preventDefault\(\);[\s\S]*?bridge\.startAssetDrag\(projectId, assetId\)/);
});

test("library and Editing both route media drag starts through native desktop drag and prepare browser media", () => {
  const thumb = read("src/components/AssetThumb.tsx");
  const reference = read("src/features/editing/ReferenceMedia.tsx");
  const editing = read("src/features/EditingWorkspace.tsx");
  assert.match(thumb, /startNativeAssetDrag\(e, projectId, asset\.id\)/);
  assert.match(reference, /startNativeAssetDrag\(event, projectId, asset\.id\)/);
  // Media lives inside a paragraph whose dragstart cancels non-text drags.
  assert.match(reference, /onDragStart=\{\(event\) => \{[\s\S]*?event\.stopPropagation\(\);[\s\S]*?startNativeAssetDrag/);
  assert.match(reference, /prepareAudioDragFile\(asset\)/);
  assert.match(reference, /prepareVideoDragFile\(asset\)/);
  assert.match(editing, /startNativeAssetDrag\(event, projectId, asset\.id\)/);
});
