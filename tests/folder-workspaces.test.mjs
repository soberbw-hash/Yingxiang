import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import "fake-indexeddb/auto";
import {
  pendingLibraryUpdates,
  libraryUpdateSummary,
} from "../src/services/libraryUpdates.ts";
import {
  appendCommit,
  hashBlob,
  optionalJson,
  readDiskFile,
  readCommits,
  writeDiskFile,
  pathParts,
  directoryPermission,
  historyPath,
} from "../src/services/directoryFiles.ts";
import {
  saveFolderProject,
  loadFolderProject,
} from "../src/services/folderProjects.ts";
import {
  initializeLibrary,
  publishToLibrary,
  librarySnapshot,
  sharedAssetBlob,
  editSharedAsset,
  scanExternalLibrary,
  sharedConflictVersions,
  resolveSharedConflict,
  imageLibraryInput,
  syncLibraryDirectory,
} from "../src/services/sharedLibrary.ts";
import {
  browserInvoke,
  browserProjectData,
} from "../src/services/browserRepository.ts";
import {
  attachProjectFolder,
  folderBrowserInvoke,
} from "../src/services/folderBrowser.ts";
import {
  folderConnections,
  rememberFolder,
  ensureIndependentFolder,
  forgetFolder,
} from "../src/services/folderConnections.ts";
import { scanDirectory } from "../src/services/directoryScan.ts";
import {
  createLibraryNoticeStore,
  noticeGroups,
} from "../src/services/libraryNotices.ts";

const nativeClone = globalThis.structuredClone;
const handles = new Map();
// fake-indexeddb cannot serialize native directory handles. This test adapter
// models handle persistence only; it is not a company Chrome permission test.
function mapHandles(value, encode) {
  if (encode && value instanceof Directory) {
    handles.set(value.diskPath, value);
    return { __testDirectory: value.diskPath };
  }
  if (!encode && value?.__testDirectory)
    return handles.get(value.__testDirectory);
  if (Array.isArray(value))
    return value.map((item) => mapHandles(item, encode));
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        mapHandles(item, encode),
      ]),
    );
  return value;
}
globalThis.structuredClone = (value) =>
  mapHandles(nativeClone(mapHandles(value, true)), false);
const nativeChannel = globalThis.BroadcastChannel;
globalThis.BroadcastChannel = undefined;
Object.defineProperty(navigator, "locks", {
  configurable: true,
  value: { request: async (_key, work) => work() },
});
after(() => {
  globalThis.structuredClone = nativeClone;
  globalThis.BroadcastChannel = nativeChannel;
  delete navigator.locks;
});

function missing() {
  return new DOMException("missing", "NotFoundError");
}
class Directory {
  kind = "directory";
  constructor(diskPath, control = { permission: "granted" }) {
    this.diskPath = diskPath;
    this.name = path.basename(diskPath);
    this.control = control;
  }
  async getDirectoryHandle(name, { create = false } = {}) {
    assert.ok(name && !/[\\/]/.test(name) && name !== "..");
    const target = path.join(this.diskPath, name);
    if (create) await fs.mkdir(target, { recursive: true });
    try {
      if (!(await fs.stat(target)).isDirectory()) throw missing();
    } catch (error) {
      if (error.code === "ENOENT") throw missing();
      throw error;
    }
    return new Directory(target, this.control);
  }
  async getFileHandle(name, { create = false } = {}) {
    assert.ok(name && !/[\\/]/.test(name) && name !== "..");
    const target = path.join(this.diskPath, name),
      control = this.control;
    if (create) {
      const file = await fs.open(target, "a");
      await file.close();
    }
    try {
      await fs.stat(target);
    } catch (error) {
      if (error.code === "ENOENT") throw missing();
      throw error;
    }
    return {
      kind: "file",
      name,
      getFile: async () => new Blob([await fs.readFile(target)]),
      createWritable: async () => {
        let data;
        return {
          write: async (value) => {
            data =
              typeof value === "string"
                ? value
                : new Uint8Array(await value.arrayBuffer());
          },
          close: async () => {
            if (control.fail?.(target)) throw new Error("模拟断盘/磁盘已满");
            await fs.writeFile(target, data);
          },
          abort: async () => {},
        };
      },
    };
  }
  async removeEntry(name) {
    await fs.unlink(path.join(this.diskPath, name));
  }
  async *values() {
    for (const entry of await fs.readdir(this.diskPath, {
      withFileTypes: true,
    }))
      yield entry.isDirectory()
        ? await this.getDirectoryHandle(entry.name)
        : await this.getFileHandle(entry.name);
  }
  async queryPermission() {
    return this.control.permission;
  }
  async requestPermission() {
    return this.control.permission;
  }
  async isSameEntry(other) {
    return this.diskPath === other.diskPath;
  }
  async resolve(other) {
    const relative = path.relative(this.diskPath, other.diskPath);
    return relative === ""
      ? []
      : relative.startsWith("..") || path.isAbsolute(relative)
        ? null
        : relative.split(path.sep);
  }
}
async function fixture(t) {
  const location = await fs.mkdtemp(
    path.join(os.tmpdir(), "weave-folder-test-"),
  );
  t.after(async () => {
    const resolved = path.resolve(location);
    assert.ok(
      resolved.startsWith(path.join(os.tmpdir(), "weave-folder-test-")),
    );
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return new Directory(location);
}
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=",
  "base64",
);
async function asset(name = "人物 原图.png", extra = {}) {
  const blob = new Blob([png], { type: "image/png" });
  const now = new Date().toISOString(),
    id = randomUUID();
  return {
    blob,
    asset: {
      id,
      name,
      relativePath: `media/${id}.png`,
      kind: "image",
      category: "character",
      mime: "image/png",
      hash: await hashBlob(blob),
      size: blob.size,
      revision: 1,
      prompt: "客户秘密提示词",
      tags: ["内部"],
      source: "GPT",
      status: "candidate",
      createdAt: now,
      updatedAt: now,
      ...extra,
    },
  };
}

test("real directory publications become persistent foreign notices, open exact original, retain history after trash", async (t) => {
  const root = await fixture(t),
    id = await initializeLibrary(root),
    values = new Map();
  const store = createLibraryNoticeStore(id, "reader", {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  });
  store.observe((await librarySnapshot(root)).updates);
  const input = await asset();
  await publishToLibrary(root, "coworker", [input], "character");
  const snapshot = await librarySnapshot(root);
  const result = store.observe(snapshot.updates);
  assert.equal(result.added.length, 1);
  const group = noticeGroups(result.state.entries)[0];
  const linked = snapshot.assets.find((item) => item.id === group.assetIds[0]);
  assert.equal(
    await hashBlob(await sharedAssetBlob(root, linked)),
    input.asset.hash,
  );
  store.markRead(group.entryIds);
  await editSharedAsset(root, "coworker", linked, {
    trashedAt: new Date().toISOString(),
  });
  store.observe((await librarySnapshot(root)).updates);
  assert.equal(store.read().entries.length, 1);
  assert.ok(store.read().entries[0].readAt);
  assert.equal(
    (await librarySnapshot(root)).assets[0].trashedAt !== undefined,
    true,
  );
});
function record(asset) {
  return {
    project: {
      id: randomUUID(),
      name: "私有项目",
      root: "directory:test",
      createdAt: new Date().toISOString(),
      schemaVersion: 1,
    },
    assets: [asset],
    shots: [],
    activities: [],
  };
}

test("directory scan waits for stable files, excludes internal/nested projects and never alters sources", async (t) => {
  const root = await fixture(t),
    state = new Map();
  await writeDiskFile(root, "角色/新增.png", new Blob([png]));
  await writeDiskFile(root, "角色/下载.crdownload", "partial");
  await writeDiskFile(root, "_Weave/历史原片/忽略.png", new Blob([png]));
  await writeDiskFile(root, "导出/忽略.png", new Blob([png]));
  await writeDiskFile(root, `角色/副本__${randomUUID()}.png`, new Blob([png]));
  await writeDiskFile(root, "子项目/weave.project-folder.json", "{}");
  await writeDiskFile(root, "子项目/忽略.png", new Blob([png]));
  assert.equal(
    (await scanDirectory(root, state, { now: 10000 })).files.length,
    0,
  );
  assert.equal(
    (await scanDirectory(root, state, { now: 11000 })).files.length,
    0,
  );
  const result = await scanDirectory(root, state, { now: 12000 });
  assert.deepEqual(
    result.files.map((file) => [file.path, file.category]),
    [["角色/新增.png", "character"]],
  );
  assert.deepEqual(
    Buffer.from(
      await (await readDiskFile(root, "角色/新增.png")).arrayBuffer(),
    ),
    png,
  );
  await writeDiskFile(root, "角色/新增.png", new Blob([png, "new"]));
  assert.equal(
    (await scanDirectory(root, state, { now: 13000 })).files.length,
    0,
  );
  assert.equal(
    (await scanDirectory(root, state, { now: 15000 })).files.length,
    1,
  );
});

test("managed public folder discovers external additions and changed sources, preserves trash and originals", async (t) => {
  const root = await fixture(t),
    state = new Map();
  await initializeLibrary(root);
  await writeDiskFile(root, "产品/新增产品.png", new Blob([png]));
  assert.equal((await syncLibraryDirectory(root, state, 10000)).added, 0);
  const imported = await syncLibraryDirectory(root, state, 12000);
  assert.equal(imported.added, 1);
  assert.equal(imported.snapshot.assets[0].group, "product");
  assert.equal(imported.snapshot.updates[0].clientId, "external-directory");
  assert.equal((await syncLibraryDirectory(root, state, 14000)).added, 0);
  await editSharedAsset(root, "self", imported.snapshot.assets[0], {
    trashedAt: new Date().toISOString(),
  });
  const restarted = new Map();
  await syncLibraryDirectory(root, restarted, 16000);
  assert.equal((await syncLibraryDirectory(root, restarted, 18000)).added, 0);
  await writeDiskFile(
    root,
    "产品/新增产品.png",
    new Blob([png, "new version"]),
  );
  assert.equal((await syncLibraryDirectory(root, state, 20000)).added, 0);
  const changed = await syncLibraryDirectory(root, state, 22000);
  assert.equal(changed.added, 1);
  assert.equal(changed.snapshot.assets.length, 2);
  assert.equal(changed.snapshot.assets.filter((a) => a.trashedAt).length, 1);
  await root
    .getDirectoryHandle("产品")
    .then((dir) => dir.removeEntry("新增产品.png"));
  assert.equal(
    (await syncLibraryDirectory(root, state, 24000)).snapshot.assets.length,
    2,
  );
});

test("readonly directory refreshes same-size replacements with new preview identity and update ID", async (t) => {
  const root = await fixture(t);
  await writeDiskFile(root, "场景/同名.png", new Blob([png]));
  const before = await scanExternalLibrary(root, "readonly");
  const changed = Buffer.from(png);
  changed[changed.length - 1] ^= 1;
  await writeDiskFile(root, "场景/同名.png", new Blob([changed]));
  const after = await scanExternalLibrary(root, "readonly");
  assert.equal(after.assets[0].id, before.assets[0].id);
  assert.notEqual(after.assets[0].head, before.assets[0].head);
  assert.notEqual(after.updates[0].id, before.updates[0].id);
});

test("personal directory imports external sources once, refreshes disk changes and preserves links after source deletion", async (t) => {
  const root = await fixture(t),
    created = await browserInvoke("createProject", { name: "自动同步测试" });
  await attachProjectFolder(root, created.id);
  const id = (await folderBrowserInvoke("bootstrap")).activeProjectId;
  const connection = (await folderConnections()).find((item) => item.id === id);
  await writeDiskFile(connection.handle, "场景/新素材.png", new Blob([png]));
  const clock = { value: Date.now() };
  t.mock.method(Date, "now", () => clock.value);
  assert.equal(
    (await folderBrowserInvoke("syncProjectFolder", { projectId: id }))
      .imported,
    0,
  );
  clock.value += 2000;
  assert.equal(
    (await folderBrowserInvoke("syncProjectFolder", { projectId: id }))
      .imported,
    1,
  );
  let disk = await loadFolderProject(connection.handle);
  assert.equal(disk.record.assets[0].category, "scene");
  const assetId = disk.record.assets[0].id;
  assert.equal(
    (await folderBrowserInvoke("syncProjectFolder", { projectId: id }))
      .imported,
    0,
  );
  await folderBrowserInvoke("trashAssets", {
    projectId: id,
    ids: [assetId],
    revisions: { [assetId]: 1 },
  });
  assert.equal(
    (await folderBrowserInvoke("syncProjectFolder", { projectId: id }))
      .imported,
    0,
  );
  const next = structuredClone(disk.record);
  // Simulate an independent disk metadata update and verify cache refresh.
  disk = await loadFolderProject(connection.handle);
  disk.record.project.name = "磁盘更新后的名称";
  await saveFolderProject(
    connection.handle,
    disk.record,
    disk.media,
    disk.commitId,
    "other-window",
  );
  assert.equal(
    (await folderBrowserInvoke("syncProjectFolder", { projectId: id })).changed,
    true,
  );
  assert.equal(
    (await browserProjectData(id)).record.project.name,
    "磁盘更新后的名称",
  );
  await connection.handle
    .getDirectoryHandle("场景")
    .then((dir) => dir.removeEntry("新素材.png"));
  await folderBrowserInvoke("syncProjectFolder", { projectId: id });
  assert.equal(
    (await loadFolderProject(connection.handle)).record.assets[0].id,
    next.assets[0].id,
  );
  connection.handle.control.permission = "denied";
  await assert.rejects(
    folderBrowserInvoke("syncProjectFolder", { projectId: id }),
    /授权已失效/,
  );
  connection.handle.control.permission = "granted";
  await forgetFolder(connection.key);
});

test("changing project location keeps identity and history, switches only after verified copy and retains source", async (t) => {
  const from = await fixture(t),
    target = await fixture(t);
  const created = await browserInvoke("createProject", {
    name: "更改路径测试",
  });
  await browserInvoke("importFiles", {
    projectId: created.id,
    files: [{ name: "原图.png", blob: new Blob([png]) }],
  });
  await attachProjectFolder(from, created.id);
  const id = (await folderBrowserInvoke("bootstrap")).activeProjectId;
  const prior = (await folderConnections()).find((item) => item.id === id);
  const disk = await loadFolderProject(prior.handle);
  target.control.fail = (file) => file.endsWith(".png");
  await assert.rejects(
    folderBrowserInvoke("relocateProjectFolder", {
      projectId: id,
      handle: target,
    }),
    /断盘/,
  );
  assert.equal(
    (await folderConnections()).find((item) => item.id === id).handle.diskPath,
    prior.handle.diskPath,
  );
  delete target.control.fail;
  await folderBrowserInvoke("relocateProjectFolder", {
    projectId: id,
    handle: target,
  });
  const current = (await folderConnections()).find((item) => item.id === id);
  assert.notEqual(current.handle.diskPath, prior.handle.diskPath);
  assert.equal(
    (await loadFolderProject(current.handle)).commitId,
    disk.commitId,
  );
  assert.equal((await loadFolderProject(prior.handle)).record.project.id, id);
  await assert.rejects(
    folderBrowserInvoke("relocateProjectFolder", {
      projectId: id,
      handle: current.handle,
    }),
    /子目录/,
  );
  await forgetFolder(current.key);
});

test("failed automatic project commit restores cache, preserves source, and retries without losing files", async (t) => {
  const root = await fixture(t),
    created = await browserInvoke("createProject", { name: "同步故障" });
  await attachProjectFolder(root, created.id);
  const id = (await folderBrowserInvoke("bootstrap")).activeProjectId;
  const connection = (await folderConnections()).find((item) => item.id === id);
  await writeDiskFile(connection.handle, "下载.png", new Blob([png]));
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  await folderBrowserInvoke("syncProjectFolder", { projectId: id });
  now += 2000;
  root.control.fail = (file) => file.includes(`${path.sep}提交${path.sep}`);
  await assert.rejects(
    folderBrowserInvoke("syncProjectFolder", { projectId: id }),
    /断盘/,
  );
  assert.equal((await browserProjectData(id)).record.assets.length, 0);
  assert.equal(
    (await loadFolderProject(connection.handle)).record.assets.length,
    0,
  );
  assert.equal(
    (await readDiskFile(connection.handle, "下载.png")).size,
    png.length,
  );
  delete root.control.fail;
  assert.equal(
    (await folderBrowserInvoke("syncProjectFolder", { projectId: id }))
      .imported,
    1,
  );
  assert.equal(
    (await loadFolderProject(connection.handle)).record.assets.length,
    1,
  );
  await forgetFolder(connection.key);
});

test("moving a browser-only project to disk retains its identity, originals and existing record", async (t) => {
  const target = await fixture(t),
    created = await browserInvoke("createProject", {
      name: "浏览器工程迁入目录",
    });
  await browserInvoke("importFiles", {
    projectId: created.id,
    files: [{ name: "原图.png", blob: new Blob([png]) }],
  });
  const original = await browserProjectData(created.id);
  await folderBrowserInvoke("relocateProjectFolder", {
    projectId: created.id,
    handle: target,
  });
  const connection = (await folderConnections()).find(
    (item) => item.id === created.id,
  );
  const disk = await loadFolderProject(connection.handle);
  assert.equal(disk.record.project.id, created.id);
  assert.deepEqual(disk.record.assets, original.record.assets);
  assert.deepEqual(Buffer.from(await disk.media[0].blob.arrayBuffer()), png);
  assert.equal(
    (await browserProjectData(created.id)).record.project.root,
    `directory:${created.id}`,
  );
  await forgetFolder(connection.key);
});

test("public directory write denial reports pending files without fake additions or modifying sources", async (t) => {
  const root = await fixture(t),
    state = new Map();
  await initializeLibrary(root);
  await writeDiskFile(root, "新增.png", new Blob([png]));
  await syncLibraryDirectory(root, state, 10000);
  root.control.fail = () => true;
  const result = await syncLibraryDirectory(root, state, 12000);
  assert.equal(result.added, 0);
  assert.match(result.snapshot.warnings.join(), /未收录/);
  assert.equal((await librarySnapshot(root)).assets.length, 0);
  assert.deepEqual(
    Buffer.from(await (await readDiskFile(root, "新增.png")).arrayBuffer()),
    png,
  );
  delete root.control.fail;
  assert.equal((await syncLibraryDirectory(root, state, 14000)).added, 1);
});

test("new category folders and public Other persist without altering originals", async (t) => {
  const root = await fixture(t),
    input = await asset("其他参考.png", { category: "other" }),
    project = record(input.asset);
  await saveFolderProject(
    root,
    project,
    [{ id: input.asset.id, hash: input.asset.hash, blob: input.blob }],
    null,
    "self",
  );
  assert.match(
    (await loadFolderProject(root)).paths[input.asset.id],
    /^其他\//,
  );
  const audioRoot = await fixture(t);
  const audio = await asset("旁白.wav", {
    kind: "audio",
    category: "audio",
    mime: "audio/wav",
  });
  const audioProject = record(audio.asset);
  await saveFolderProject(
    audioRoot,
    audioProject,
    [{ id: audio.asset.id, hash: audio.asset.hash, blob: audio.blob }],
    null,
    "self",
  );
  assert.match(
    (await loadFolderProject(audioRoot)).paths[audio.asset.id],
    /^音频\//,
  );
  const library = await fixture(t);
  await initializeLibrary(library);
  await publishToLibrary(library, "self", [input], "other");
  const published = (await librarySnapshot(library)).assets[0];
  assert.equal(published.category, "other");
  assert.match(published.relativePath, /^其他\//);
  assert.equal(published.hash, input.asset.hash);
  const scanRoot = await fixture(t);
  await writeDiskFile(scanRoot, "音频/旁白.wav", new Blob(["wave"]));
  await writeDiskFile(scanRoot, "其他/参考.png", input.blob);
  const state = new Map();
  await scanDirectory(scanRoot, state, { now: 10000 });
  assert.deepEqual(
    (await scanDirectory(scanRoot, state, { now: 12000 })).files
      .map((file) => file.category)
      .sort(),
    ["audio", "other"],
  );
});

test("directory stack, paragraph group links and failures keep every original and committed version", async (t) => {
  const root = await fixture(t),
    created = await browserInvoke("createProject", { name: "目录堆叠" });
  const movie = (value) =>
    new Blob([
      new Uint8Array([
        0,
        0,
        0,
        24,
        102,
        116,
        121,
        112,
        105,
        115,
        111,
        109,
        0,
        0,
        0,
        value,
      ]),
    ]);
  await browserInvoke("importFiles", {
    projectId: created.id,
    files: [
      { name: "A.mp4", blob: movie(31) },
      { name: "B.mp4", blob: movie(32) },
    ],
    category: "video",
  });
  await attachProjectFolder(root, created.id);
  const id = (await folderBrowserInvoke("bootstrap")).activeProjectId,
    connection = (await folderConnections()).find((item) => item.id === id);
  let disk = await loadFolderProject(connection.handle);
  const [a, b] = disk.record.assets;
  const revisions = () =>
    Object.fromEntries(
      disk.record.assets.map((asset) => [asset.id, asset.revision]),
    );
  await folderBrowserInvoke("editAssetStack", {
    projectId: id,
    action: { type: "merge", id: a.id, assetIds: [b.id] },
    revisions: revisions(),
  });
  await folderBrowserInvoke("editReference", {
    projectId: id,
    revision: 0,
    action: { type: "import", text: "一段文稿", mode: "blank" },
  });
  disk = await loadFolderProject(connection.handle);
  await folderBrowserInvoke("editReference", {
    projectId: id,
    revision: 1,
    action: {
      type: "link",
      id: disk.record.editing.paragraphs[0].id,
      assetIds: [a.id],
    },
  });
  disk = await loadFolderProject(connection.handle);
  assert.equal(disk.record.editing.paragraphs[0].links.length, 2);
  assert.equal(
    new Set(disk.record.assets.map((asset) => asset.stackId)).size,
    1,
  );
  root.control.fail = (file) => file.includes(`${path.sep}提交${path.sep}`);
  await assert.rejects(
    folderBrowserInvoke("editAssetStack", {
      projectId: id,
      action: { type: "final", id: a.id },
      revisions: revisions(),
    }),
    /断盘/,
  );
  delete root.control.fail;
  assert.equal(
    (await loadFolderProject(connection.handle)).record.assets.filter(
      (asset) => asset.status === "final",
    ).length,
    0,
  );
  assert.equal(
    (await browserProjectData(id)).record.assets.filter(
      (asset) => asset.status === "final",
    ).length,
    0,
  );
  for (const media of disk.media)
    assert.equal(await hashBlob(media.blob), media.hash);
  await forgetFolder(connection.key);
});

test("folder-to-folder group transfer saves target before touching source, and source-save failure keeps both copies", async (t) => {
  const rootA = await fixture(t),
    rootB = await fixture(t);
  const movie = (value) =>
    new Blob([
      new Uint8Array([
        0,
        0,
        0,
        24,
        102,
        116,
        121,
        112,
        105,
        115,
        111,
        109,
        0,
        0,
        0,
        value,
      ]),
    ]);
  const source = await browserInvoke("createProject", { name: "堆叠源" });
  await browserInvoke("importFiles", {
    projectId: source.id,
    files: [
      { name: "A.mp4", blob: movie(41) },
      { name: "B.mp4", blob: movie(42) },
    ],
  });
  await attachProjectFolder(rootA, source.id);
  const a = (await folderBrowserInvoke("bootstrap")).activeProjectId,
    ca = (await folderConnections()).find((item) => item.id === a);
  let disk = await loadFolderProject(ca.handle);
  const ids = disk.record.assets.map((asset) => asset.id);
  await folderBrowserInvoke("editAssetStack", {
    projectId: a,
    action: { type: "merge", id: ids[0], assetIds: [ids[1]] },
    revisions: Object.fromEntries(
      disk.record.assets.map((asset) => [asset.id, asset.revision]),
    ),
  });
  const target = await browserInvoke("createProject", { name: "堆叠目标" });
  await attachProjectFolder(rootB, target.id);
  const b = (await folderBrowserInvoke("bootstrap")).activeProjectId,
    cb = (await folderConnections()).find((item) => item.id === b);
  disk = await loadFolderProject(ca.handle);
  const revisions = Object.fromEntries(
    disk.record.assets.map((asset) => [asset.id, asset.revision]),
  );
  rootB.control.fail = (file) => file.includes(`${path.sep}提交${path.sep}`);
  await assert.rejects(
    folderBrowserInvoke("transferAssets", {
      projectId: a,
      targetProjectId: b,
      ids,
      move: true,
      revisions,
    }),
    /源项目保留/,
  );
  delete rootB.control.fail;
  assert.equal((await loadFolderProject(cb.handle)).record.assets.length, 0);
  assert.equal(
    (await loadFolderProject(ca.handle)).record.assets.filter(
      (asset) => !asset.trashedAt,
    ).length,
    2,
  );
  rootA.control.fail = (file) => file.includes(`${path.sep}提交${path.sep}`);
  await assert.rejects(
    folderBrowserInvoke("transferAssets", {
      projectId: a,
      targetProjectId: b,
      ids,
      move: true,
      revisions,
    }),
    /目标项目已保存完整副本/,
  );
  delete rootA.control.fail;
  const saved = (await loadFolderProject(cb.handle)).record.assets;
  assert.equal(saved.length, 2);
  assert.equal(new Set(saved.map((asset) => asset.stackId)).size, 1);
  assert.notEqual(saved[0].stackId, disk.record.assets[0].stackId);
  assert.deepEqual(
    saved.map((asset) => asset.hash).sort(),
    disk.record.assets.map((asset) => asset.hash).sort(),
  );
  assert.equal(
    (await loadFolderProject(ca.handle)).record.assets.filter(
      (asset) => !asset.trashedAt,
    ).length,
    2,
  );
  await forgetFolder(ca.key);
  await forgetFolder(cb.key);
});

test("image import naming writes the chosen physical filename and subsequent rename archives the old path without touching source", async (t) => {
  const source = await fixture(t),
    root = await fixture(t);
  await writeDiskFile(source, "源文件.png", new Blob([png]));
  const created = await browserInvoke("createProject", { name: "命名落盘" });
  await attachProjectFolder(root, created.id);
  const id = (await folderBrowserInvoke("bootstrap")).activeProjectId,
    connection = (await folderConnections()).find((item) => item.id === id);
  await folderBrowserInvoke("importFiles", {
    projectId: id,
    files: [
      { name: "用户命名.png", blob: await readDiskFile(source, "源文件.png") },
    ],
    category: "character",
  });
  let disk = await loadFolderProject(connection.handle);
  const asset = disk.record.assets[0];
  assert.match(disk.paths[asset.id], /^角色\/用户命名__/);
  assert.equal(
    (await readDiskFile(connection.handle, disk.paths[asset.id])).size,
    png.length,
  );
  await folderBrowserInvoke("updateAssets", {
    projectId: id,
    ids: [asset.id],
    patch: { name: "再次命名.png" },
    revisions: { [asset.id]: asset.revision },
  });
  disk = await loadFolderProject(connection.handle);
  assert.match(disk.paths[asset.id], /^角色\/再次命名__/);
  assert.deepEqual(
    Buffer.from(await (await readDiskFile(source, "源文件.png")).arrayBuffer()),
    png,
  );
  assert.equal(
    (await readDiskFile(connection.handle, historyPath(asset))).size,
    png.length,
  );
  await forgetFolder(connection.key);
});

test("local folder saves full bytes in readable classification, reopens without browser data, and archives old paths", async (t) => {
  const root = await fixture(t),
    input = await asset(),
    project = record(input.asset);
  const media = [
    { id: input.asset.id, hash: input.asset.hash, blob: input.blob },
  ];
  await saveFolderProject(root, project, media, null, "local");
  let disk = await loadFolderProject(root);
  assert.ok(disk.paths[input.asset.id].startsWith("角色/人物 原图__"));
  assert.deepEqual(Buffer.from(await disk.media[0].blob.arrayBuffer()), png);
  project.assets[0].category = "scene";
  project.assets[0].revision++;
  await saveFolderProject(root, project, media, disk.commitId, "local");
  disk = await loadFolderProject(root);
  assert.ok(disk.paths[input.asset.id].startsWith("场景/"));
  assert.equal((await readCommits(root)).length, 2);
  assert.equal(
    (await readDiskFile(root, historyPath(input.asset))).size,
    png.length,
  );
  assert.equal((await fs.readdir(path.join(root.diskPath, "角色"))).length, 0);
});
test("disk failure retains previous committed project and rejects stale or newer-format saves", async (t) => {
  const root = await fixture(t),
    input = await asset(),
    project = record(input.asset),
    media = [{ id: input.asset.id, hash: input.asset.hash, blob: input.blob }];
  await saveFolderProject(root, project, media, null, "a");
  const old = await loadFolderProject(root);
  project.assets[0].prompt = "修改后";
  root.control.fail = (target) => target.includes(`${path.sep}提交${path.sep}`);
  await assert.rejects(
    saveFolderProject(root, project, media, old.commitId, "a"),
    /断盘/,
  );
  delete root.control.fail;
  assert.equal(
    (await loadFolderProject(root)).record.assets[0].prompt,
    "客户秘密提示词",
  );
  await assert.rejects(
    saveFolderProject(root, project, media, "stale", "b"),
    /已被另一窗口/,
  );
  await writeDiskFile(
    root,
    "_Weave/提交/new.json",
    JSON.stringify({ format: "weave-disk-commit", schemaVersion: 99 }),
  );
  await assert.rejects(loadFolderProject(root), /更新或未知/);
});
test("public publication copies original, excludes private metadata, deduplicates, and verifies before reuse", async (t) => {
  const root = await fixture(t),
    input = await asset();
  await initializeLibrary(root);
  assert.deepEqual(
    await publishToLibrary(root, "client-a", [input], "product"),
    { added: 1, duplicates: 0 },
  );
  let snapshot = await librarySnapshot(root),
    entry = snapshot.assets[0];
  assert.ok(entry.relativePath.startsWith("产品/"));
  assert.equal(entry.prompt, "");
  assert.deepEqual(entry.tags, []);
  assert.equal(entry.origin.assetId, input.asset.id);
  assert.deepEqual(
    Buffer.from(await (await sharedAssetBlob(root, entry)).arrayBuffer()),
    png,
  );
  assert.deepEqual(
    await publishToLibrary(root, "client-b", [input], "character"),
    { added: 0, duplicates: 1 },
  );
  assert.equal((await librarySnapshot(root)).updates.length, 1);
  await writeDiskFile(root, entry.relativePath, new Blob(["changed"]));
  await assert.rejects(sharedAssetBlob(root, entry), /修改或移动/);
  assert.equal(input.asset.prompt, "客户秘密提示词");
});
test("two public writers add independently; concurrent edits are explicit conflicts, never last-write-wins", async (t) => {
  const root = await fixture(t);
  await initializeLibrary(root);
  const first = await asset();
  const second = await asset("第二张.png");
  second.blob = new Blob([png, new Uint8Array([7])]);
  second.asset.hash = await hashBlob(second.blob);
  second.asset.size = second.blob.size;
  await Promise.all([
    publishToLibrary(root, "client-a", [first]),
    publishToLibrary(root, "client-b", [second]),
  ]);
  const snapshot = await librarySnapshot(root);
  assert.equal(snapshot.assets.length, 2);
  const base = snapshot.assets.find((item) => item.hash === first.asset.hash);
  const { head, conflict, url, ...entry } = base;
  await Promise.all(
    ["client-a", "client-b"].map((clientId) =>
      appendCommit(
        root,
        {
          kind: "library",
          action: "edit",
          entries: [{ ...entry, name: `${clientId}.png`, revision: 2 }],
        },
        head,
        clientId,
      ),
    ),
  );
  const conflicted = (await librarySnapshot(root)).assets.find(
    (item) => item.id === base.id,
  );
  assert.equal(conflicted.conflict, true);
  await assert.rejects(
    editSharedAsset(root, "client-c", conflicted, { group: "scene" }),
    /其他窗口修改/,
  );
  assert.deepEqual(
    Buffer.from(await (await sharedAssetBlob(root, base)).arrayBuffer()),
    png,
  );
  const versions = await sharedConflictVersions(root, base.id);
  await assert.rejects(
    resolveSharedConflict(root, "c", base.id, versions[0].head, ["stale"]),
    /版本已有变化/,
  );
  await resolveSharedConflict(
    root,
    "c",
    base.id,
    versions[0].head,
    versions.map((version) => version.head),
  );
  const resolved = (await librarySnapshot(root)).assets.find(
    (item) => item.id === base.id,
  );
  assert.equal(resolved.conflict, false);
  assert.equal(resolved.name, versions[0].entry.name);
  assert.equal((await sharedConflictVersions(root, base.id)).length, 1);
});
test("shared category change, soft trash and restore keep readable files and retained recovery bytes", async (t) => {
  const root = await fixture(t);
  await initializeLibrary(root);
  await publishToLibrary(root, "a", [await asset()]);
  let entry = (await librarySnapshot(root)).assets[0];
  await editSharedAsset(root, "a", entry, { group: "scene" });
  entry = (await librarySnapshot(root)).assets[0];
  assert.equal(entry.group, "scene");
  assert.ok(entry.relativePath.startsWith("场景/"));
  await editSharedAsset(root, "a", entry, {
    trashedAt: new Date().toISOString(),
  });
  entry = (await librarySnapshot(root)).assets[0];
  assert.ok(entry.trashedAt);
  assert.ok(entry.relativePath.startsWith("_Weave/回收站/"));
  await editSharedAsset(root, "a", entry, { trashedAt: null });
  entry = (await librarySnapshot(root)).assets[0];
  assert.ok(!entry.trashedAt);
  assert.deepEqual(
    Buffer.from(await (await sharedAssetBlob(root, entry)).arrayBuffer()),
    png,
  );
});
test("existing folder link is read-only and traversals, denied grants and bad hashes fail safely", async (t) => {
  const root = await fixture(t);
  await writeDiskFile(root, "角色/既有角色.png", new Blob([png]));
  const before = await fs.readdir(root.diskPath);
  const snapshot = await scanExternalLibrary(root, "linked");
  assert.equal(snapshot.assets.length, 1);
  assert.equal(snapshot.assets[0].external, true);
  assert.equal(snapshot.assets[0].group, "character");
  assert.deepEqual(await fs.readdir(root.diskPath), before);
  assert.throws(() => pathParts("../private.png"), /不安全/);
  assert.throws(() => pathParts("C:/private.png"), /不安全/);
  root.control.permission = "denied";
  await assert.rejects(directoryPermission(root, true), /授权已失效/);
});
test("an existing image folder can become a managed public library without replacing its originals", async (t) => {
  const root = await fixture(t);
  await writeDiskFile(root, "角色/既有角色.png", new Blob([png]));
  await writeDiskFile(root, "_Weave/目录说明.txt", "已有说明");
  const id = await initializeLibrary(root);
  assert.equal((await librarySnapshot(root)).id, id);
  const state = new Map();
  await syncLibraryDirectory(root, state, 1000, "test-client");
  const result = await syncLibraryDirectory(root, state, 5000, "test-client");
  assert.equal(result.snapshot.assets.length, 1);
  assert.deepEqual(Buffer.from(await (await readDiskFile(root, "角色/既有角色.png")).arrayBuffer()), png);
  assert.equal(await (await readDiskFile(root, "_Weave/目录说明.txt")).text(), "已有说明");
  const edited = await editSharedAsset(root, "test-client", result.snapshot.assets[0], { group: "scene" });
  assert.ok(edited);
  assert.deepEqual(Buffer.from(await (await readDiskFile(root, "角色/既有角色.png")).arrayBuffer()), png);
});
test("browser legacy project remains intact; disk copy saves and failed writes roll working cache back", async (t) => {
  const parent = await fixture(t);
  const created = await browserInvoke("createProject", {
    name: "旧浏览器工程",
  });
  await browserInvoke("importFiles", {
    projectId: created.id,
    files: [{ name: "原图.png", blob: new Blob([png]) }],
    category: "character",
  });
  await attachProjectFolder(parent, created.id);
  let state = await folderBrowserInvoke("bootstrap");
  const diskId = state.snapshot.project.id;
  assert.notEqual(diskId, created.id);
  assert.equal((await browserProjectData(created.id)).record.assets.length, 1);
  const diskConnection = (await folderConnections()).find(
    (item) => item.id === diskId,
  );
  const selected = state.snapshot.assets[0];
  await folderBrowserInvoke("updateAssets", {
    projectId: diskId,
    ids: [selected.id],
    revisions: { [selected.id]: selected.revision },
    patch: { name: "改名.png" },
  });
  assert.equal(
    (await loadFolderProject(diskConnection.handle)).record.assets[0].name,
    "改名.png",
  );
  const prior = await browserProjectData(diskId);
  parent.control.fail = (target) =>
    target.includes(`${path.sep}提交${path.sep}`);
  await assert.rejects(
    folderBrowserInvoke("updateAssets", {
      projectId: diskId,
      ids: [selected.id],
      revisions: { [selected.id]: prior.record.assets[0].revision },
      patch: { name: "失败改名.png" },
    }),
    /断盘/,
  );
  delete parent.control.fail;
  assert.equal(
    (await browserProjectData(diskId)).record.assets[0].name,
    "改名.png",
  );
  assert.equal(
    (await loadFolderProject(diskConnection.handle)).record.assets[0].name,
    "改名.png",
  );
  assert.equal(
    (await browserProjectData(created.id)).record.assets[0].name,
    "原图.png",
  );
  await forgetFolder(diskConnection.key);
  await assert.rejects(
    folderBrowserInvoke("updateAssets", {
      projectId: diskId,
      ids: [selected.id],
      revisions: { [selected.id]: prior.record.assets[0].revision },
      patch: { name: "不能仅写缓存.png" },
    }),
    /目录连接已失效/,
  );
});
test("direct public image import validates file signature and preserves original bytes", async () => {
  const input = await imageLibraryInput(
    new File([png], "产品.png", { type: "image/png" }),
  );
  assert.equal(input.asset.hash, await hashBlob(new Blob([png])));
  assert.deepEqual(Buffer.from(await input.blob.arrayBuffer()), png);
  const mislabeled = await imageLibraryInput(new File([png], "实际是图片.jpeg"));
  assert.equal(mislabeled.asset.name, "实际是图片.png");
  assert.equal(mislabeled.asset.mime, "image/png");
  assert.deepEqual(Buffer.from(await mislabeled.blob.arrayBuffer()), png);
  await assert.rejects(
    imageLibraryInput(new File(["not a photo"], "假图.png")),
    /不是兼容的图片/,
  );
});
test("public library preserves existing folder names for new and previously collected images", async (t) => {
  const root = await fixture(t);
  await initializeLibrary(root);
  await writeDiskFile(root, "自定义分类/图片.jpeg", new Blob([png]));
  const state = new Map();
  await syncLibraryDirectory(root, state, 1000);
  const collected = await syncLibraryDirectory(root, state, 5000);
  assert.equal(collected.added, 1);
  assert.equal(collected.snapshot.assets[0].sourceFolder, "自定义分类");
  assert.ok(collected.snapshot.folders.includes("自定义分类"));
  assert.equal(collected.snapshot.assets[0].name, "图片.png");
  assert.deepEqual(Buffer.from(await (await readDiskFile(root, "自定义分类/图片.jpeg")).arrayBuffer()), png);
  assert.equal((await librarySnapshot(root)).assets[0].sourceFolder, "自定义分类");
  const edited = await editSharedAsset(root, "client", collected.snapshot.assets[0], { group: "scene" });
  assert.equal(edited.entry.sourceFolder, undefined);
  const refreshed = await syncLibraryDirectory(root, state, 9000);
  assert.equal(refreshed.snapshot.assets[0].sourceFolder, undefined);
});
test("legacy collected public images recover an unambiguous original folder for browsing", async (t) => {
  const root = await fixture(t);
  await initializeLibrary(root);
  await writeDiskFile(root, "品牌素材/图片.png", new Blob([png]));
  await publishToLibrary(root, "old", [await imageLibraryInput(new File([png], "图片.png"))]);
  const state = new Map();
  await syncLibraryDirectory(root, state, 1000);
  const result = await syncLibraryDirectory(root, state, 5000);
  assert.equal(result.added, 0);
  assert.equal(result.snapshot.assets[0].sourceFolder, "品牌素材");
});
test("local and public roots cannot overlap or silently expose personal projects", async (t) => {
  const root = await fixture(t);
  await rememberFolder({
    key: "public-library",
    id: randomUUID(),
    name: root.name,
    handle: root,
    kind: "library",
    mode: "managed",
  });
  await assert.rejects(
    ensureIndependentFolder(root, "local"),
    /不能相同或互相包含/,
  );
  await assert.rejects(
    ensureIndependentFolder(
      await root.getDirectoryHandle("私人项目", { create: true }),
      "local",
    ),
    /不能相同或互相包含/,
  );
  const other = await fixture(t);
  await ensureIndependentFolder(other, "local");
  await forgetFolder("public-library");
});

test("unsafe format renames and oversized publication batches are rejected before committing", async (t) => {
  const root = await fixture(t);
  await initializeLibrary(root);
  const input = await asset();
  await assert.rejects(
    publishToLibrary(root, "a", Array(1001).fill(input)),
    /最多收录/,
  );
  assert.equal((await readCommits(root)).length, 0);
  await publishToLibrary(root, "a", [input]);
  const entry = (await librarySnapshot(root)).assets[0];
  await assert.rejects(
    editSharedAsset(root, "a", entry, { name: "不能变格式.jpg" }),
    /保留原扩展名/,
  );
  assert.equal((await librarySnapshot(root)).assets[0].name, entry.name);
  const created = await browserInvoke("createProject", {
    name: "扩展名保护测试",
  });
  await browserInvoke("importFiles", {
    projectId: created.id,
    files: [{ name: "图.png", blob: input.blob }],
    category: "character",
  });
  const cached = (await browserProjectData(created.id)).record.assets[0];
  await assert.rejects(
    browserInvoke("updateAssets", {
      projectId: created.id,
      ids: [cached.id],
      revisions: { [cached.id]: cached.revision },
      patch: { name: "图.jpg" },
    }),
    /保留原扩展名/,
  );
  assert.equal(
    (await browserProjectData(created.id)).record.assets[0].name,
    "图.png",
  );
  const empty = await fixture(t);
  await assert.rejects(
    appendCommit(empty, { text: "x".repeat(16 * 1024 * 1024) }, null, "a"),
    /提交记录过大/,
  );
  assert.deepEqual(await fs.readdir(empty.diskPath), []);
});

test("public update batching excludes own client, read entries and already-notified entries", () => {
  const updates = [
    { id: "a", clientId: "self", category: "character", count: 5 },
    { id: "b", clientId: "other", category: "character", count: 2 },
    { id: "c", clientId: "other", category: "scene", count: 1 },
    { id: "d", clientId: "other", category: "character", count: 9 },
    { id: "e", clientId: "other", category: "scene", count: 7 },
    { id: "f", clientId: "third", category: "character", count: 1 },
  ];
  const pending = pendingLibraryUpdates(
    updates,
    "self",
    new Set(["d"]),
    new Set(["e"]),
  );
  assert.deepEqual(
    pending.map((update) => update.id),
    ["b", "c", "f"],
  );
  assert.equal(
    libraryUpdateSummary(pending),
    "角色库新增 3 个素材；场景库新增 1 个素材",
  );
  assert.deepEqual(
    pendingLibraryUpdates(updates, "", new Set(), new Set()),
    [],
  );
});

test("new projects use the chosen local root and revoked permission never silently falls back", async (t) => {
  const root = await fixture(t);
  await rememberFolder({
    key: "local-project-root",
    kind: "project-root",
    id: randomUUID(),
    name: root.name,
    handle: root,
  });
  const created = await folderBrowserInvoke("createProject", {
    name: "真实目录新建",
  });
  const connection = (await folderConnections()).find(
    (item) => item.kind === "project" && item.id === created.id,
  );
  assert.ok(connection);
  assert.equal(
    (await loadFolderProject(connection.handle)).record.project.name,
    "真实目录新建",
  );
  await folderBrowserInvoke("importFiles", {
    projectId: created.id,
    files: [{ name: "角色.png", blob: new Blob([png]) }],
    category: "character",
  });
  const loaded = await loadFolderProject(connection.handle);
  assert.equal(loaded.record.assets.length, 1);
  assert.ok(loaded.paths[loaded.record.assets[0].id].startsWith("角色/"));
  const before = (await folderBrowserInvoke("bootstrap")).projects.length;
  root.control.permission = "denied";
  await assert.rejects(
    folderBrowserInvoke("createProject", { name: "不能假装落盘" }),
    /授权已失效/,
  );
  root.control.permission = "granted";
  assert.equal(
    (await folderBrowserInvoke("bootstrap")).projects.length,
    before,
  );
  await forgetFolder(connection.key);
  await forgetFolder("local-project-root");
});

test("simultaneous identical public additions remain manageable instead of reappearing after deletion", async (t) => {
  const root = await fixture(t);
  await initializeLibrary(root);
  const input = await asset();
  await Promise.all([
    publishToLibrary(root, "a", [input]),
    publishToLibrary(root, "b", [input]),
  ]);
  const snapshot = await librarySnapshot(root);
  // A race may be serialized by the filesystem, in which case normal dedup applies.
  if (snapshot.assets.length === 2) {
    assert.match(snapshot.warnings.join(), /内容相同/);
    await editSharedAsset(root, "a", snapshot.assets[0], {
      trashedAt: new Date().toISOString(),
    });
    const after = await librarySnapshot(root);
    assert.equal(after.assets.filter((item) => !item.trashedAt).length, 1);
    assert.equal(after.assets.filter((item) => item.trashedAt).length, 1);
  } else assert.equal(snapshot.assets.length, 1);
});

test("folder projects persist editing/audio and reject failed saves without losing prior associations", async (t) => {
  const root = await fixture(t);
  const created = await browserInvoke("createProject", {
    name: "目录剪辑验证",
  });
  const wav = new Blob([
    new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 65, 86, 69]),
  ]);
  await browserInvoke("importFiles", {
    projectId: created.id,
    files: [{ name: "旁白.wav", blob: wav }],
  });
  await attachProjectFolder(root, created.id);
  const state = await folderBrowserInvoke("bootstrap"),
    id = state.snapshot.project.id;
  const connection = (await folderConnections()).find(
    (item) => item.kind === "project" && item.id === id,
  );
  await folderBrowserInvoke("editReference", {
    projectId: id,
    revision: 0,
    action: { type: "import", text: "对应旁白\n\n下一段", mode: "blank" },
  });
  let disk = await loadFolderProject(connection.handle);
  const paragraphId = disk.record.editing.paragraphs[0].id,
    audioId = disk.record.assets[0].id;
  assert.ok(disk.paths[audioId].startsWith("音频/"));
  await folderBrowserInvoke("editReference", {
    projectId: id,
    revision: 1,
    action: { type: "link", id: paragraphId, assetIds: [audioId] },
  });
  disk = await loadFolderProject(connection.handle);
  assert.equal(disk.record.editing.paragraphs[0].links[0].assetId, audioId);
  const before = structuredClone(disk.record.editing);
  root.control.fail = (target) => target.includes(`${path.sep}提交${path.sep}`);
  await assert.rejects(
    folderBrowserInvoke("editReference", {
      projectId: id,
      revision: 2,
      action: { type: "primary", id: paragraphId, assetId: audioId },
    }),
    /断盘/,
  );
  delete root.control.fail;
  assert.deepEqual(
    (await loadFolderProject(connection.handle)).record.editing,
    before,
  );
  assert.deepEqual((await browserProjectData(id)).record.editing, before);
  assert.deepEqual(
    (await loadFolderProject(connection.handle)).record.assets[0].hash,
    await hashBlob(wav),
  );
  await forgetFolder(connection.key);
});
