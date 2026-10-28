import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import "fake-indexeddb/auto";
import { applyEditing } from "../shared/editing.mjs";
import { rememberEditingVersion, validateEditingHistory } from "../shared/editing-history.mjs";
import { browserInvoke, browserProjectData, installBrowserProject, namedExportPaths } from "../src/services/browserRepository.ts";
import { buildBackup, parseProjectArchive } from "../src/services/projectArchive.ts";
import { readZip, createZip } from "../src/services/zip.ts";
import { planEditingVideos, buildEditingVideos } from "../src/services/editingHandoff.ts";
import { readResume, readFavorites, readSavedSearches, readScrollBookmark, writePreference } from "../src/services/workspacePreferences.ts";
const { ProjectRepository } = createRequire(import.meta.url)("../electron/project-repository.cjs");
const originalChannel = globalThis.BroadcastChannel;
globalThis.BroadcastChannel = undefined;
after(() => { globalThis.BroadcastChannel = originalChannel; });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=", "base64");
const movie = number => new Blob([Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109,0,0,0,0,number])], { type: "video/mp4" });
const edit = (doc, action, assets = []) => applyEditing(doc, action, assets, [], doc?.revision || 0);

test("durable versions coalesce typing and retain states before structural changes", () => {
  let doc = edit(undefined, { type: "import", text: "第一段\n\n第二段", mode: "blank" });
  const initial = structuredClone(doc), id = doc.paragraphs[0].id;
  let history = rememberEditingVersion(undefined, doc, { type: "text", id }, "2026-10-26T01:00:00Z");
  doc = edit(doc, { type: "text", id, text: "第一段修改" });
  history = rememberEditingVersion(history, doc, { type: "text", id }, "2026-10-26T01:00:30Z");
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].document, initial);
  history = rememberEditingVersion(history, doc, { type: "merge", id }, "2026-10-26T01:01:00Z");
  doc = edit(doc, { type: "merge", id });
  assert.equal(history.length, 2);
  const restored = edit(doc, { type: "restoreDocument", document: history[1].document });
  assert.deepEqual(restored.paragraphs.map(p => p.text), ["第一段修改", "第二段"]);
  for (let i = 0; i < 55; i++) history = rememberEditingVersion(history, restored, { type: "title" });
  assert.equal(history.length, 40);
  assert.equal(validateEditingHistory(history).length, 40);
  assert.throws(() => validateEditingHistory([...history, history[0]]), /格式无效/);
});

async function fixture() {
  const project = await browserInvoke("createProject", { name: "恢复闭环" });
  await browserInvoke("importFiles", { projectId: project.id, files: [
    { name: "角色（夜景）· [参考] ✨.PNG", blob: new Blob([png]) },
    { name: "开场.mp4", blob: movie(1) }, { name: "开场备选.MP4", blob: movie(2) },
  ] });
  await browserInvoke("editReference", { projectId: project.id, revision: 0, action: { type: "import", text: "开场正文\n\n第二段", mode: "blank" } });
  let data = await browserProjectData(project.id);
  const id = data.record.editing.paragraphs[0].id;
  for (const action of [{ type: "link", id, assetIds: data.record.assets.filter(a => a.kind === "video").map(a => a.id) }, { type: "text", id, text: "修改后的开场正文" }]) {
    await browserInvoke("editReference", { projectId: project.id, revision: data.record.editing.revision, action });
    data = await browserProjectData(project.id);
  }
  const image = data.record.assets.find(a => a.kind === "image");
  await browserInvoke("trashAssets", { projectId: project.id, ids: [image.id], revisions: { [image.id]: image.revision } });
  return browserProjectData(project.id);
}

test("product classification survives browser backup and restore", async () => {
  const project = await browserInvoke("createProject", { name: "产品分类测试" });
  await browserInvoke("importFiles", { projectId: project.id, category: "product", files: [{ name: "产品.png", blob: new Blob([png]) }] });
  const saved = await browserProjectData(project.id);
  assert.equal(saved.record.assets[0].category, "product");
  const restored = await parseProjectArchive(await buildBackup(saved.record, saved.media));
  assert.equal(restored.record.assets[0].category, "product");
  assert.deepEqual(Buffer.from(await restored.media[0].blob.arrayBuffer()), png);
});

test("complete browser backup restores names, trash, all bytes and durable history atomically", async () => {
  const data = await fixture(), original = structuredClone(data.record);
  assert.deepEqual((await browserInvoke("bootstrap")).snapshot.editingHistory, data.record.editingHistory);
  await assert.rejects(browserInvoke("editReference", { projectId: data.record.project.id, revision: 0, action: { type: "add" } }), /其他窗口/);
  assert.deepEqual((await browserProjectData(data.record.project.id)).record.editingHistory, data.record.editingHistory);
  // Exercise user-facing portable paths, including characters rejected by the old reader.
  data.record.assets = namedExportPaths(data.record.assets);
  const archive = await buildBackup(data.record, data.media);
  const prepared = await parseProjectArchive(archive);
  assert.equal(prepared.archiveKind, "backup");
  assert.equal(prepared.record.assets.length, 3);
  assert.equal(prepared.record.assets.filter(a => a.trashedAt).length, 1);
  assert.equal(prepared.record.editingHistory.length, 2);
  assert.deepEqual(prepared.record.editing, data.record.editing);
  assert.deepEqual(prepared.record.editingHistory, data.record.editingHistory);
  const restored = structuredClone(prepared.record);
  restored.project.id = crypto.randomUUID(); restored.project.root = `indexeddb://${restored.project.id}`;
  await installBrowserProject(restored, prepared.media, true);
  const saved = await browserProjectData(restored.project.id);
  for (const item of data.media) assert.deepEqual(Buffer.from(await saved.media.find(x => x.id === item.id).blob.arrayBuffer()), Buffer.from(await item.blob.arrayBuffer()));
  await assert.rejects(installBrowserProject({ ...restored, project: { ...restored.project, name: "不得覆盖" } }, [], true));
  assert.equal((await browserProjectData(restored.project.id)).record.project.name, original.project.name);
  assert.deepEqual((await browserProjectData(original.project.id)).record, original);
  const plan = planEditingVideos(saved.record.editing, saved.record.assets);
  assert.equal(plan.files.length, 2);
  assert.match(plan.files[0].filename, /^01-1_/);
  assert.match(plan.files[1].filename, /^01-2_/);
  assert.deepEqual(plan.withoutVideo, [2]);
  const packaged = await buildEditingVideos(saved.record.editing, saved.record.assets, async a => saved.media.find(x => x.id === a.id).blob);
  assert.deepEqual([...await readZip(packaged.blob)].map(([name]) => name), plan.files.map(f => `剪辑视频/${f.filename}`));
});

test("corrupt originals and traversal paths are rejected without changing stored project", async () => {
  const data = await fixture(), archive = await buildBackup(data.record, data.media), files = await readZip(archive);
  const victim = data.record.assets[0];
  const changed = new Map(files); changed.set(victim.relativePath, new Uint8Array([1, 2, 3]));
  await assert.rejects(parseProjectArchive(createZip([...changed].map(([name, bytes]) => ({ name, bytes })))), /原片校验失败/);
  const manifest = JSON.parse(new TextDecoder().decode(files.get("weave.backup.json")));
  manifest.record.assets[0].relativePath = "media/../escape.png";
  files.set("weave.backup.json", new TextEncoder().encode(JSON.stringify(manifest)));
  await assert.rejects(parseProjectArchive(createZip([...files].map(([name, bytes]) => ({ name, bytes })))), /路径无效/);
  assert.deepEqual((await browserProjectData(data.record.project.id)).record, data.record);
});

test("backup action downloads only after its archive passes the real recovery reader", async () => {
  const data = await fixture();
  const savedDocument = globalThis.document, savedTimeout = globalThis.setTimeout, create = URL.createObjectURL;
  let blob, clicked = false, filename = "";
  globalThis.document = { createElement: () => ({ style: {}, set download(v) { filename = v; }, click() { clicked = true; }, remove() {} }), body: { appendChild() {} } };
  URL.createObjectURL = value => { blob = value; return "blob:weave-download-test"; };
  globalThis.setTimeout = (...args) => { const timer = savedTimeout(...args); timer.unref(); return timer; };
  try {
    const result = await browserInvoke("exportBackup", { projectId: data.record.project.id });
    assert.ok(result.verified && result.downloaded && clicked);
    assert.match(filename, /完整备份.zip$/);
    assert.equal((await parseProjectArchive(blob)).media.length, data.media.length);
    assert.equal((await parseProjectArchive(blob)).record.assets.filter(a => a.trashedAt).length, 1);
    const partial = await browserInvoke("exportBackup", { projectId: data.record.project.id, includeTrash: false });
    const recovered = await parseProjectArchive(blob);
    assert.match(filename, /不含回收站/);
    assert.equal(partial.trashCount, 0);
    assert.equal(recovered.record.assets.length, data.record.assets.length - 1);
    assert.equal(recovered.record.assets.filter(a => a.trashedAt).length, 0);
    assert.equal((await browserProjectData(data.record.project.id)).record.assets.length, data.record.assets.length);
  } finally { globalThis.document = savedDocument; globalThis.setTimeout = savedTimeout; URL.createObjectURL = create; }
});

test("desktop versions survive reopen and verified folder backup", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "weave-workflow-"));
  t.after(async () => { assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep + "weave-workflow-")); await fs.rm(temp, { recursive: true, force: true }); });
  const options = { userData: path.join(temp, "app") }, repo = new ProjectRepository(options);
  const snap = repo.createProject({ name: "历史持久化", root: path.join(temp, "project") }), projectId = snap.project.id;
  await repo.editReference({ projectId, revision: 0, action: { type: "import", text: "原正文", mode: "blank" } });
  const initial = repo.snapshot(projectId).editing;
  await repo.editReference({ projectId, revision: initial.revision, action: { type: "text", id: initial.paragraphs[0].id, text: "新正文" } });
  const opened = new ProjectRepository(options).snapshot(projectId);
  assert.deepEqual(opened.editingHistory[0].document, initial);
  const backup = repo.safety.create(projectId);
  const history = JSON.parse(await fs.readFile(path.join(backup.path, "metadata", "editing-history.json"), "utf8"));
  assert.deepEqual(history, opened.editingHistory);
});

test("personal filters and resume reject malformed preferences and keep projects isolated", () => {
  const old = globalThis.localStorage, values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  try {
    writePreference("weave.resume.a", { view: "shots", search: "角色", filter: "character" });
    assert.equal(readResume("a").view, "shots"); assert.equal(readResume("b").view, "library");
    writePreference("weave.resume.b", { view: "javascript", search: 1, filter: "invalid" });
    assert.deepEqual(readResume("b"), { view: "library", search: "", filter: "all" });
    writePreference("weave.favorites.a", ["x", "x", 4]); assert.deepEqual(readFavorites("a"), ["x"]);
    writePreference("weave.searches.a", [{ id: "one", name: "夜景", search: "夜", category: "scene", kind: "image", favorites: true, sort: "name" }, { kind: "invalid" }]);
    assert.equal(readSavedSearches("a").length, 1);
    writePreference("weave.scroll.a:editing", { top: 0, anchor: "p1", offset: -30, index: 85 });
    assert.equal(readScrollBookmark("a:editing").index, 85);
    globalThis.localStorage.setItem = () => { throw new Error("quota"); };
    assert.equal(writePreference("x", {}), false);
  } finally { globalThis.localStorage = old; }
});

test("portable filenames keep complete Unicode characters and avoid Windows device names", async () => {
  const data = await fixture();
  const record = structuredClone(data.record);
  record.assets[0].name = `${"字".repeat(119)}✨结尾.PNG`;
  record.assets[1].name = "CON.mp4";
  record.assets[2].name = "con.mp4";
  record.assets = namedExportPaths(record.assets);
  assert.match(record.assets[0].relativePath, /✨\.PNG$/u);
  assert.match(record.assets[1].relativePath, /\/_CON.mp4$/);
  assert.notEqual(record.assets[1].relativePath.toLowerCase(), record.assets[2].relativePath.toLowerCase());
  const result = await parseProjectArchive(await buildBackup(record, data.media));
  assert.equal(result.media.length, 3);
});
