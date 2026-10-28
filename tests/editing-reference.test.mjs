import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import "fake-indexeddb/auto";
import {
  applyEditing,
  validateEditing,
  editingForExport,
  splitDocument,
} from "../shared/editing.mjs";
import {
  browserInvoke,
  browserProjectData,
  namedExportPaths,
} from "../src/services/browserRepository.ts";
import {
  buildEditingHandoff,
  buildEditingVideos,
} from "../src/services/editingHandoff.ts";
import { readZip } from "../src/services/zip.ts";
import {
  buildBackup,
  parseProjectArchive,
} from "../src/services/projectArchive.ts";
import { hashBlob } from "../src/services/directoryFiles.ts";
const { ProjectRepository } = createRequire(import.meta.url)(
  "../electron/project-repository.cjs",
);
const nativeChannel = globalThis.BroadcastChannel;
globalThis.BroadcastChannel = undefined;
after(() => {
  globalThis.BroadcastChannel = nativeChannel;
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=",
  "base64",
);
function wave() {
  const out = Buffer.alloc(44 + 1600);
  out.write("RIFF");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(8000, 24);
  out.writeUInt32LE(16000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(1600, 40);
  return out;
}
async function assets() {
  return Promise.all(
    [
      ["参考.png", "image", "image/png", png],
      ["旁白.wav", "audio", "audio/wav", wave()],
      [
        "视频.mp4",
        "video",
        "video/mp4",
        Buffer.from([
          0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0,
        ]),
      ],
    ].map(async ([name, kind, mime, data]) => {
      const id = crypto.randomUUID(),
        blob = new Blob([data], { type: mime }),
        now = new Date().toISOString();
      return {
        id,
        name,
        kind,
        mime,
        relativePath: `media/${id}.${name.split(".").pop()}`,
        category: "uncategorized",
        status: "candidate",
        size: blob.size,
        hash: await hashBlob(blob),
        revision: 1,
        createdAt: now,
        updatedAt: now,
        source: "客户秘密来源",
        prompt: "客户秘密提示词",
        tags: [],
        blob,
      };
    }),
  );
}
function edit(doc, action, files = [], shots = []) {
  return applyEditing(doc, action, files, shots, doc?.revision || 0);
}
test("whole text append preserves originals, stable IDs and rejects stale/future writes", () => {
  const raw = "甲\r\n\r\n乙\n丙";
  assert.deepEqual(splitDocument(raw), ["甲", "乙\n丙"]);
  assert.deepEqual(splitDocument(raw, "line"), ["甲", "乙", "丙"]);
  let doc = edit(undefined, { type: "import", text: raw, mode: "blank" });
  const id = doc.paragraphs[0].id;
  doc = edit(doc, { type: "import", text: "追加文稿", mode: "blank" });
  assert.equal(doc.sources[0].text, raw);
  assert.equal(doc.paragraphs[0].id, id);
  assert.equal(doc.paragraphs.length, 3);
  assert.throws(
    () => applyEditing(doc, { type: "add" }, [], [], 0),
    /其他窗口/,
  );
  assert.throws(
    () => validateEditing({ ...doc, version: 99 }, []),
    /格式不受支持/,
  );
  assert.throws(() => splitDocument("x", "unknown"), /分段方式无效/);
});
test("editing document snapshots can be safely restored for undo and redo", () => {
  const original = edit(undefined, { type: "import", text: "原始段落", mode: "blank" });
  const paragraphId = original.paragraphs[0].id;
  const changed = edit(original, { type: "split", id: paragraphId, at: 2 });
  const undone = applyEditing(changed, { type: "restoreDocument", document: original }, [], [], changed.revision);
  assert.deepEqual(undone.paragraphs, original.paragraphs);
  assert.equal(undone.revision, changed.revision + 1);
  const redone = applyEditing(undone, { type: "restoreDocument", document: changed }, [], [], undone.revision);
  assert.deepEqual(redone.paragraphs, changed.paragraphs);
  const cleared = applyEditing(redone, { type: "restoreDocument", document: null }, [], [], redone.revision);
  assert.equal(cleared.paragraphs.length, 0);
  assert.equal(cleared.sources.length, 0);
  assert.equal(cleared.revision, redone.revision + 1);
  assert.throws(
    () => applyEditing(cleared, { type: "restoreDocument", document: original }, [], [], changed.revision),
    /其他窗口/,
  );
});
test("splitting at the start of a Chinese phrase keeps the exact caret boundary", () => {
  const text = "前文内容，男主叹了口气。\n老小区里，两人慢慢走着。";
  let doc = edit(undefined, { type: "import", text, mode: "blank" });
  const id = doc.paragraphs[0].id;
  doc = edit(doc, { type: "split", id, at: text.indexOf("老小区") });
  assert.equal(doc.paragraphs[0].text, "前文内容，男主叹了口气。\n");
  assert.equal(doc.paragraphs[1].text, "老小区里，两人慢慢走着。");
});
test("editing mutations used by split, merge, deletion and video drops can round-trip through document history", async () => {
  const files = await assets();
  let doc = edit(undefined, { type: "import", text: "前段内容后段内容", mode: "blank" }, files);
  const id = doc.paragraphs[0].id;
  doc = edit(doc, { type: "link", id, assetIds: [files[0].id] }, files);
  const history = [];
  const mutate = (action) => {
    const before = structuredClone(doc);
    doc = edit(doc, action, files);
    history.push({ before, after: structuredClone(doc) });
  };
  mutate({ type: "split", id, at: 4 });
  mutate({ type: "merge", id, count: 1 });
  mutate({ type: "unlink", id, assetId: files[0].id });
  mutate({ type: "link", id, assetIds: [files[0].id] });
  mutate({ type: "remove", id });
  for (const entry of [...history].reverse()) {
    doc = applyEditing(doc, { type: "restoreDocument", document: entry.before }, files, [], doc.revision);
    assert.deepEqual(doc.paragraphs, entry.before.paragraphs);
    doc = applyEditing(doc, { type: "restoreDocument", document: entry.after }, files, [], doc.revision);
    assert.deepEqual(doc.paragraphs, entry.after.paragraphs);
  }
});
test("selected text can be extracted as an adjacent paragraph without losing order, links, marks, notes, or undoability", async () => {
  const files = await assets();
  let doc = edit(undefined, { type: "import", text: "上段前选中选中后下段", mode: "blank" }, files);
  const paragraphId = doc.paragraphs[0].id;
  doc = edit(doc, { type: "link", id: paragraphId, assetIds: [files[0].id] }, files);
  doc = edit(doc, { type: "mark", id: paragraphId, start: 3, end: 7, quote: "选中选中" }, files);
  doc = edit(doc, { type: "note", id: paragraphId, text: "保留原批注", quote: "上段" }, files);
  const before = structuredClone(doc);
  doc = edit(doc, { type: "extractSelection", id: paragraphId, start: 3, end: 7, quote: "选中选中" }, files);
  assert.deepEqual(doc.paragraphs.map((item) => item.text), ["上段前", "选中选中", "后下段"]);
  assert.equal(doc.paragraphs[0].id, paragraphId);
  assert.deepEqual(doc.paragraphs.map((item) => item.links), [
    before.paragraphs[0].links,
    [],
    [],
  ]);
  assert.deepEqual(doc.paragraphs.map((item) => item.marks), [[], [{ start: 0, end: 4 }], []]);
  assert.equal(doc.paragraphs[0].notes[0].text, "保留原批注");
  assert.deepEqual(doc.paragraphs[1].notes, []);
  const undone = applyEditing(doc, { type: "restoreDocument", document: before }, files, [], doc.revision);
  assert.deepEqual(undone.paragraphs, before.paragraphs);
  assert.throws(
    () => edit(doc, { type: "extractSelection", id: paragraphId, start: 3, end: 7, quote: "过期选区" }, files),
    /选中文字已变化/,
  );
});
test("selected excerpts from adjacent paragraphs combine into one independent middle paragraph", async () => {
  const files = await assets();
  let doc = edit(undefined, { type: "import", text: "甲乙丙丁\n\n戊己庚辛", mode: "blank" }, files);
  const [upper, lower] = doc.paragraphs.map((item) => item.id);
  doc = edit(doc, { type: "link", id: upper, assetIds: [files[0].id] }, files);
  doc = edit(doc, { type: "mark", id: upper, start: 0, end: 4, quote: "甲乙丙丁" }, files);
  const before = structuredClone(doc);
  doc = edit(doc, {
    type: "combineSelections",
    selections: [
      { id: lower, start: 0, end: 2, quote: "戊己" },
      { id: upper, start: 1, end: 3, quote: "乙丙" },
    ],
  }, files);
  assert.deepEqual(doc.paragraphs.map((item) => item.text), ["甲丁", "乙丙\n戊己", "庚辛"]);
  assert.deepEqual(doc.paragraphs[0].links, before.paragraphs[0].links);
  assert.deepEqual(doc.paragraphs[1].links, []);
  assert.deepEqual(doc.paragraphs[0].marks, [{ start: 0, end: 1 }, { start: 1, end: 2 }]);
  const undone = applyEditing(doc, { type: "restoreDocument", document: before }, files, [], doc.revision);
  assert.deepEqual(undone.paragraphs, before.paragraphs);
  assert.throws(() => edit(doc, {
    type: "combineSelections",
    selections: [
      { id: upper, start: 1, end: 3, quote: "过期" },
      { id: lower, start: 0, end: 2, quote: "戊己" },
    ],
  }, files), /选中文字已变化/);
});
test("paragraph text, completion, selected marks and comments persist without shifting old marks", () => {
  let doc = edit(undefined, {
    type: "import",
    text: "第一段文字\n\n第二段",
    mode: "blank",
  });
  const id = doc.paragraphs[0].id,
    untouched = doc.paragraphs[1].id;
  doc = edit(doc, { type: "mark", id, start: 1, end: 3 });
  doc = edit(doc, { type: "generated", id, value: true });
  doc = edit(doc, { type: "note", id, text: "这里用近景", quote: "第一段" });
  assert.equal(doc.paragraphs[0].notes[0].quote, "第一段");
  const noteId = doc.paragraphs[0].notes[0].id;
  doc = edit(doc, { type: "resolveNote", id, noteId, value: true });
  assert.equal(doc.paragraphs[0].notes[0].resolved, true);
  doc = edit(doc, { type: "text", id, text: "修改后的文字" });
  assert.deepEqual(doc.paragraphs[0].marks, []);
  assert.equal(doc.paragraphs[0].generated, false);
  assert.equal(doc.paragraphs[1].id, untouched);
  assert.equal(doc.paragraphs[0].notes[0].quote, "第一段");
  doc = edit(doc, { type: "deleteNote", id, noteId });
  assert.deepEqual(doc.paragraphs[0].notes, []);
  assert.throws(() => edit(doc, { type: "deleteNote", id, noteId }), /批注不存在/);
  assert.throws(
    () => edit(doc, { type: "mark", id, start: 0, end: 1000 }),
    /位置无效/,
  );
  assert.throws(
    () => edit(doc, { type: "mark", id, start: 0, end: 2, quote: "旧文字" }),
    /文字已变化/,
  );
});
test("primary/alternate is paragraph-scoped; split, merge, unlink and soft remove keep original assets", async () => {
  const files = await assets(),
    [a, b] = files;
  let doc = edit(
    undefined,
    { type: "import", text: "相同素材服务第一段\n\n第二段", mode: "blank" },
    files,
  );
  const [first, second] = doc.paragraphs.map((p) => p.id);
  doc = edit(doc, { type: "link", id: first, assetIds: [a.id, b.id] }, files);
  doc = edit(doc, { type: "primary", id: first, assetId: a.id }, files);
  doc = edit(doc, { type: "link", id: second, assetIds: [a.id, b.id] }, files);
  doc = edit(doc, { type: "primary", id: second, assetId: b.id }, files);
  assert.equal(doc.paragraphs[0].links[0].role, "primary");
  assert.equal(doc.paragraphs[1].links[0].role, "alternate");
  assert.equal(a.status, "candidate");
  const beforeSplitLinks = structuredClone(doc.paragraphs[0].links);
  doc = edit(doc, { type: "split", id: first, at: 2 }, files);
  assert.equal(doc.paragraphs.length, 3);
  assert.equal(doc.paragraphs[0].text, "相同");
  assert.equal(doc.paragraphs[1].text, "素材服务第一段");
  assert.deepEqual(doc.paragraphs[0].links, beforeSplitLinks);
  assert.deepEqual(doc.paragraphs[1].links, []);
  doc = edit(doc, { type: "merge", id: first }, files);
  assert.equal(doc.paragraphs.length, 2);
  assert.equal(doc.removed.length, 1);
  doc = edit(doc, { type: "unlink", id: first, assetId: a.id }, files);
  assert.equal(doc.paragraphs[1].links.length, 2);
  assert.equal(files.length, 3);
  doc = edit(doc, { type: "remove", id: second }, files);
  assert.equal(doc.paragraphs.length, 1);
  doc = edit(doc, { type: "restore", id: second }, files);
  assert.equal(doc.paragraphs.length, 2);
});
test("merging adjacent paragraphs retains every distinct video reference and source role safely", async () => {
  const files = await assets();
  const blob = new Blob(["second-video"], { type: "video/mp4" });
  const secondVideo = {
    ...files[2],
    id: crypto.randomUUID(),
    name: "第二段视频.mp4",
    relativePath: `media/${crypto.randomUUID()}.mp4`,
    size: blob.size,
    hash: await hashBlob(blob),
    blob,
  };
  files.push(secondVideo);
  let doc = edit(undefined, {
    type: "import",
    text: "第一段已选视频\n\n第二段也已选视频",
    mode: "blank",
  }, files);
  const [firstId, secondId] = doc.paragraphs.map((p) => p.id);
  doc = edit(doc, { type: "link", id: firstId, assetIds: [files[2].id] }, files);
  doc = edit(doc, { type: "primary", id: firstId, assetId: files[2].id }, files);
  doc = edit(doc, { type: "link", id: secondId, assetIds: [secondVideo.id] }, files);
  doc = edit(doc, { type: "primary", id: secondId, assetId: secondVideo.id }, files);
  const expected = [files[2].id, secondVideo.id];

  doc = edit(doc, { type: "merge", id: firstId }, files);

  assert.deepEqual(doc.paragraphs[0].links.map((link) => link.assetId), expected);
  assert.equal(doc.paragraphs[0].links[0].role, "primary");
  assert.equal(doc.paragraphs[0].links[1].role, "alternate");
  assert.deepEqual(doc.removed[0].paragraph.links.map((link) => link.assetId), [secondVideo.id]);
  assert.equal(files.length, 4);
});
test("paragraph-linked media can be reordered without changing links or roles", async () => {
  const files = await assets();
  let doc = edit(undefined, { type: "import", text: "镜头", mode: "blank" }, files);
  const id = doc.paragraphs[0].id;
  doc = edit(doc, { type: "link", id, assetIds: files.map(file => file.id) }, files);
  doc = edit(doc, { type: "primary", id, assetId: files[1].id }, files);
  doc = edit(doc, { type: "reorderLinks", id, assetIds: [files[2].id, files[0].id, files[1].id] }, files);
  assert.deepEqual(doc.paragraphs[0].links.map(link => link.assetId), [files[2].id, files[0].id, files[1].id]);
  assert.equal(doc.paragraphs[0].links[2].role, "primary");
  assert.throws(() => edit(doc, { type: "reorderLinks", id, assetIds: [files[0].id] }, files), /素材排序已变化/);
});
test("adjacent paragraph ranges merge in one action and paragraph drag reorder preserves exact order", () => {
  let doc = edit(undefined, {
    type: "import",
    text: "第一段\n\n第二段\n\n第三段\n\n第四段",
    mode: "blank",
  });
  const ids = doc.paragraphs.map((paragraph) => paragraph.id);
  doc = edit(doc, { type: "moveTo", id: ids[0], index: 2 });
  assert.deepEqual(doc.paragraphs.map((paragraph) => paragraph.text), ["第二段", "第三段", "第一段", "第四段"]);
  doc = edit(doc, { type: "merge", id: ids[1], count: 2 });
  assert.equal(doc.paragraphs.length, 2);
  assert.equal(doc.paragraphs[0].text, "第二段\n\n第三段\n\n第一段");
  assert.deepEqual(doc.removed.map((item) => item.paragraph.text), ["第三段", "第一段"]);
  assert.throws(() => edit(doc, { type: "merge", id: ids[1], count: 2 }), /所选段落范围无效/);
});
test("legacy conversion is explicit and idempotent and never changes original shots or prompts", async () => {
  const files = await assets(),
    shot = {
      id: crypto.randomUUID(),
      title: "旧镜头",
      description: "画面",
      dialogue: "对白",
      prompt: "保密提示词",
      assetIds: [files[0].id],
      order: 0,
    };
  const source = structuredClone(shot);
  let doc = edit(undefined, { type: "legacy" }, files, [shot]);
  doc = edit(doc, { type: "legacy" }, files, [shot]);
  assert.equal(doc.paragraphs.length, 1);
  assert.equal(doc.paragraphs[0].legacyShotId, shot.id);
  assert.deepEqual(shot, source);
  assert.ok(!JSON.stringify(doc).includes("保密提示词"));
});
test("audio and Other categories survive import, manual reclassification and complete backup", async () => {
  const project = await browserInvoke("createProject", { name: "新分类测试" });
  await browserInvoke("importFiles", {
    projectId: project.id,
    files: [{ name: "默认旁白.wav", blob: new Blob([wave()]) }],
  });
  await browserInvoke("importFiles", {
    projectId: project.id,
    category: "other",
    files: [{ name: "其他参考.png", blob: new Blob([png]) }],
  });
  let data = await browserProjectData(project.id);
  assert.equal(data.record.assets[0].category, "audio");
  assert.equal(data.record.assets[1].category, "other");
  const audio = data.record.assets[0];
  await browserInvoke("updateAssets", {
    projectId: project.id,
    ids: [audio.id],
    revisions: { [audio.id]: audio.revision },
    patch: { category: "other" },
  });
  data = await browserProjectData(project.id);
  const parsed = await parseProjectArchive(
    await buildBackup(data.record, data.media),
  );
  assert.deepEqual(
    parsed.record.assets.map((asset) => asset.category),
    ["other", "other"],
  );
  assert.deepEqual(
    Buffer.from(
      await parsed.media
        .find((item) => item.id === audio.id)
        .blob.arrayBuffer(),
    ),
    wave(),
  );
});
test("portable browser exports use renamed media names and resolve collisions safely", () => {
  const files = [
    { id: "11111111-1111-4111-8111-111111111111", name: "卧室开场.png", relativePath: "media/a.png" },
    { id: "22222222-2222-4222-8222-222222222222", name: "卧室开场.png", relativePath: "media/b.png" },
    { id: "33333333-3333-4333-8333-333333333333", name: "不安全/文件.mp4", relativePath: "media/c.mp4" },
  ];
  assert.deepEqual(namedExportPaths(files).map(file => file.relativePath), [
    "media/卧室开场.png",
    "media/卧室开场_22222222.png",
    "media/不安全_文件.mp4",
  ]);
});

test("browser storage retains document/audio across reloads and full backup round-trip", async () => {
  const project = await browserInvoke("createProject", {
    name: "剪辑完整流程",
  });
  await browserInvoke("importFiles", {
    projectId: project.id,
    files: [{ name: "旁白.wav", blob: new Blob([wave()]) }],
    category: "uncategorized",
  });
  let snapshot = (await browserInvoke("bootstrap")).snapshot;
  assert.equal(snapshot.assets[0].kind, "audio");
  assert.equal(snapshot.assets[0].mime, "audio/wav");
  await browserInvoke("editReference", {
    projectId: project.id,
    revision: 0,
    action: { type: "import", text: "测试文稿\n\n第二段", mode: "blank" },
  });
  snapshot = (await browserInvoke("bootstrap")).snapshot;
  await browserInvoke("editReference", {
    projectId: project.id,
    revision: snapshot.editing.revision,
    action: {
      type: "link",
      id: snapshot.editing.paragraphs[0].id,
      assetIds: [snapshot.assets[0].id],
    },
  });
  await assert.rejects(
    browserInvoke("editReference", {
      projectId: project.id,
      revision: 1,
      action: { type: "add" },
    }),
    /其他窗口/,
  );
  const data = await browserProjectData(project.id),
    result = await parseProjectArchive(
      await buildBackup(data.record, data.media),
    );
  assert.deepEqual(result.record.editing, data.record.editing);
  assert.deepEqual(
    Buffer.from(await result.media[0].blob.arrayBuffer()),
    wave(),
  );
  await assert.rejects(
    browserInvoke("importFiles", {
      projectId: project.id,
      files: [{ name: "假.wav", blob: new Blob(["not audio"]) }],
    }),
    /不匹配/,
  );
});
test("legacy partial completion remains in projects but disappears from new handoffs, keeping whole completion and comments", async () => {
  let doc = edit(
    undefined,
    { type: "import", text: "第一句话。第二句话。", mode: "blank" },
    [],
  );
  const id = doc.paragraphs[0].id;
  doc = edit(
    doc,
    { type: "mark", id, start: 0, end: 5, quote: "第一句话。" },
    [],
  );
  doc = edit(doc, { type: "generated", id, value: true }, []);
  doc = edit(
    doc,
    { type: "note", id, text: "保留这条批注", quote: "第一句话。" },
    [],
  );
  const before = structuredClone(doc);
  const { blob } = await buildEditingHandoff(doc, [], async () =>
    assert.fail("no media expected"),
  );
  const zip = await readZip(blob);
  const page = new TextDecoder().decode(zip.get("剪辑对照.html"));
  assert.doesNotMatch(page, /<mark\b/);
  assert.match(page, /第一句话。第二句话。/);
  assert.match(page, /class="copy done"/);
  assert.match(page, /保留这条批注/);
  const manifest = JSON.parse(
    new TextDecoder().decode(zip.get("交接清单.json")),
  );
  assert.deepEqual(manifest.paragraphs[0].marks, []);
  assert.equal(manifest.paragraphs[0].generated, true);
  assert.deepEqual(doc, before);
  assert.equal(doc.paragraphs[0].marks.length, 1);
});

test("handoff contains playable original references, primary labels and comments, escapes HTML and omits private fields", async () => {
  const files = await assets();
  let doc = edit(
    undefined,
    {
      type: "import",
      text: "<script>alert(1)</script>\n\n第二段",
      mode: "blank",
    },
    files,
  );
  const id = doc.paragraphs[0].id;
  doc = edit(
    doc,
    { type: "link", id, assetIds: files.map((a) => a.id) },
    files,
  );
  doc = edit(doc, { type: "primary", id, assetId: files[2].id }, files);
  doc = edit(
    doc,
    { type: "note", id, text: "用主选前半段", quote: "第一段" },
    files,
  );
  const { blob } = await buildEditingHandoff(
    doc,
    files,
    async (asset) => asset.blob,
  );
  const zip = await readZip(blob),
    page = new TextDecoder().decode(zip.get("剪辑对照.html"));
  assert.match(page, /<audio controls/);
  assert.match(page, /<video controls/);
  assert.match(page, /★ 主选/);
  assert.match(page, /用主选前半段/);
  assert.match(page, /&lt;script&gt;/);
  assert.ok(!page.includes("<script>"));
  for (const a of files) {
    const entry = [...zip].find(([name]) =>
      name.endsWith(`${a.id}.${a.name.split(".").pop()}`),
    );
    assert.ok(entry);
    assert.equal(await hashBlob(new Blob([entry[1]])), a.hash);
  }
  const json = new TextDecoder().decode(zip.get("交接清单.json"));
  assert.ok(!json.includes("客户秘密"));
  assert.ok(!json.includes("sources"));
  assert.ok(!json.includes("removed"));
  await assert.rejects(
    buildEditingHandoff(doc, files, async () => new Blob(["bad"])),
    /校验失败/,
  );
  const exported = editingForExport(doc, [files[0].id]);
  assert.equal(exported.paragraphs[0].links.length, 1);
  assert.equal(doc.paragraphs[0].links.length, 3);
});
test("video-only editing export numbers paragraph options and exports only the current stack version", async () => {
  const base = await assets();
  const makeVideo = async (name, bytes, extra = {}) => {
    const blob = new Blob([bytes], { type: "video/mp4" });
    return {
      ...base[2],
      id: crypto.randomUUID(),
      name,
      relativePath: `media/${crypto.randomUUID()}.mp4`,
      size: blob.size,
      hash: await hashBlob(blob),
      blob,
      ...extra,
    };
  };
  const stackId = crypto.randomUUID();
  const oldVersion = await makeVideo("旧版本.mp4", Buffer.from("old"), {
    stackId,
    stackOrder: 1,
  });
  const currentVersion = await makeVideo("最终版本.mp4", Buffer.from("current"), {
    stackId,
    stackOrder: 2,
    status: "final",
  });
  const alternate = await makeVideo("备选.mp4", Buffer.from("alternate"));
  const later = await makeVideo("后续.mp4", Buffer.from("later"));
  const files = [...base, oldVersion, currentVersion, alternate, later];
  let doc = edit(undefined, { type: "import", text: "第一段\n\n第二段", mode: "blank" }, files);
  doc = edit(doc, { type: "link", id: doc.paragraphs[0].id, assetIds: [oldVersion.id, alternate.id] }, files);
  doc = edit(doc, { type: "link", id: doc.paragraphs[1].id, assetIds: [later.id] }, files);
  const result = await buildEditingVideos(doc, files, async (asset) => asset.blob);
  const zip = await readZip(result.blob);
  assert.deepEqual(
    [...zip.keys()],
    [
      "剪辑视频/01-1_最终版本.mp4",
      "剪辑视频/01-2_备选.mp4",
      "剪辑视频/02_后续.mp4",
    ],
  );
  assert.deepEqual(
    [...zip.get("剪辑视频/01-1_最终版本.mp4")],
    [...new Uint8Array(await currentVersion.blob.arrayBuffer())],
  );
  assert.equal(result.fileCount, 3);
  assert.match(result.name, /剪辑视频\.zip$/);
  assert.ok(![...zip.keys()].some((name) => name.includes("旧版本")));
});
test("native project stores revisioned editing metadata, includes it in export and reopens it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "weave-editing-test-"));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(
      resolved.startsWith(
        path.resolve(os.tmpdir()) + path.sep + "weave-editing-test-",
      ),
    );
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const repo = new ProjectRepository({ userData: path.join(root, "app") }),
    created = repo.createProject({
      name: "剪辑原生测试",
      root: path.join(root, "project"),
    }),
    id = created.project.id;
  repo.importFiles({
    projectId: id,
    files: [{ name: "旁白.wav", bytes: [...wave()] }],
  });
  await repo.editReference({
    projectId: id,
    revision: 0,
    action: { type: "import", text: "正文", mode: "blank" },
  });
  const snapshot = repo.snapshot(id);
  assert.equal(snapshot.assets[0].kind, "audio");
  assert.equal(snapshot.editing.paragraphs[0].text, "正文");
  await assert.rejects(
    repo.editReference({ projectId: id, revision: 0, action: { type: "add" } }),
    /其他窗口/,
  );
  const result = await repo.exportProject({
    projectId: id,
    format: "folder",
    destination: path.join(root, "exports"),
    include: { originals: true, scripts: true },
  });
  assert.ok(result);
  const entries = await fs.readdir(path.join(root, "exports"));
  const exportedRoot = path.join(
    root,
    "exports",
    entries.find((name) => !name.endsWith(".partial")),
  );
  const opened = new ProjectRepository({ userData: path.join(root, "other") });
  const p = opened.openProject({ root: exportedRoot });
  assert.equal(p.editing.paragraphs[0].text, "正文");
});

test("editing UI connects real copy drops, separate paragraph roles, audio and truthful exports", async () => {
  const app = await fs.readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const editingImport = app.match(/<EditingWorkspace[\s\S]*?onImport=\{async \(files\) => \{([\s\S]*?)\n        \}\}/)?.[1] || "";
  assert.match(editingImport, /importFiles\(accepted, "uncategorized", \{\s*projectId: snapshot\.project\.id,\s*shotId: "",/);
  assert.doesNotMatch(editingImport, /importNaming\.prepare|prepareFiles|run\("importFiles"/);
  const card = await fs.readFile(
    new URL("../src/features/editing/ParagraphCard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(card, /onDragEnter=/);
  assert.ok((card.match(/dropEffect = "copy"/g) || []).length >= 2);
  assert.match(card, /onDropFiles\(Array.from\(event.dataTransfer.files\)\)/);
  assert.match(card, /移除段落（可恢复）/);
  assert.match(card, /action\(\{ type: "remove" \}\)/);
  assert.match(card, /onClick=\{\(event\) => \{[\s\S]*?enterEditingAt\(splitAt\.current\)/);
  assert.match(card, /onPointerDown=\{\(event\) => \{[\s\S]*?getTextCaret\(editRef\.current\)[\s\S]*?splitAt\.current = caret/);
  assert.match(card, /splitPointerAt\.current = caret/);
  assert.match(card, /const at = splitPointerAt\.current \?\? splitAt\.current/);
  assert.match(card, /if \(draft !== p\.text && !\(await saveTextRef\.current\(\)\)\) return/);
  assert.match(card, /return element\.selectionStart/);
  assert.match(card, /setSelectionRange\(caret, caret\)/);
  assert.match(card, /textOffsetAtPoint\(textRef\.current, event\.clientX, event\.clientY\)/);
  assert.match(card, /data-note-dirty=\{note\.trim\(\) \? "true" : undefined\}/);
  assert.match(card, /<textarea[\s\S]*?value=\{draft\}/);
  assert.match(card, /className="paragraph-text is-editing"/);
  assert.match(card, /setTimeout\(\(\) => \{[\s\S]*?saveTextRef\.current\(\);\s*\}, 600\)/);
  assert.match(card, /onBlur=\{\(\) => \{[\s\S]*?saveTextRef\.current\(\)/);
  assert.match(card, /className="paragraph-editor">[\s\S]*?<textarea/);
  assert.doesNotMatch(card, /className="paragraph-editor-actions"/);
  assert.doesNotMatch(card, /从光标拆段/);
  assert.match(card, /role="status"[\s\S]*?已复制/);
  assert.match(card, /复制失败/);
  assert.match(card, /paragraph-reorder-handle/);
  assert.match(card, /application\/weave-paragraph/);
  assert.match(card, /type: "move", direction: -1/);
  assert.match(card, /type: "move", direction: 1/);
  assert.doesNotMatch(card, /与下一段合并/);
  assert.match(card, /onTextDraftChange\(p\.id, text\)/);
  assert.match(card, /onTextDraftChange\(p\.id, null\)/);
  assert.doesNotMatch(card, /title="编辑文字"/);
  assert.doesNotMatch(card, /Pencil(Simple)?/);
  assert.match(card, /type: "deleteNote", noteId: item\.id/);
  assert.match(card, /删除这条留言/);
  assert.match(card, /application\/weave-text-selection/);
  assert.match(card, /onStageSelection\(\{ id: p\.id, \.\.\.(?:selected|selection) \}\)/);
  const workspace = await fs.readFile(
    new URL("../src/features/EditingWorkspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(workspace, /writeAssetDrag\(event.dataTransfer, members\)/);
  assert.match(workspace, /buildEditingHandoff/);
  assert.doesNotMatch(workspace, /只看主选|复制全文|aria-label="文稿名称"/);
  assert.match(workspace, /aria-label="搜索文稿与批注"/);
  assert.match(workspace, /导出完整文稿/);
  assert.match(workspace, /URL\.createObjectURL\(new Blob\(\["\\uFEFF", text\]/);
  assert.match(workspace, /draftTexts\.current\.get\(paragraph\.id\)/);
  assert.doesNotMatch(workspace, /追加文稿/);
  assert.doesNotMatch(workspace, /hasDocument=\{!!paragraphs\.length\}/);
  assert.match(workspace, /draftTexts\.current\.get\(paragraph\.id\)/);
  assert.match(workspace, /再点击一个相邻段落，或按住 Shift 选择范围/);
  assert.match(workspace, /index === start - 1 \|\| index === end \+ 1/);
  assert.match(workspace, /\.editing-paragraph\[data-note-dirty="true"\]/);
  assert.match(workspace, /for \(const \[id, text\] of \[\.\.\.draftTexts\.current\]\)/);
  assert.match(workspace, /count: mergeIndexes\.length - 1/);
  assert.match(workspace, /交接包已生成并请求下载/);
  assert.match(workspace, /Ctrl\+Z/);
  assert.match(workspace, /window\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(workspace, /contenteditable="true"/);
  assert.match(workspace, /past\.current\.push\(\{ document: before, revision: revision\.current, label: actionLabel\(action\) \}\)/);
  assert.match(workspace, /restoreDocument/);
  assert.match(workspace, /type: "combineSelections", selections: stagedSelections/);
  assert.match(workspace, /合并为独立段/);
  const media = await fs.readFile(
    new URL("../src/features/editing/ReferenceMedia.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(media, /<video\s+controls/);
  assert.match(media, /asset\.kind !== "video" && <button/);
  assert.match(media, /reference-video/);
  assert.match(media, /reference-thumb/);
  const quick = await fs.readFile(
    new URL("../src/features/QuickPreview.tsx", import.meta.url),
    "utf8",
  );
  assert.match(quick, /<video[\s\S]*?controls/);
  assert.match(quick, /<audio[\s\S]*?controls/);
  const main = await fs.readFile(
    new URL("../electron/main.cjs", import.meta.url),
    "utf8",
  );
  assert.match(main, /result = await repo\[method\]\(payload\)/);
});
