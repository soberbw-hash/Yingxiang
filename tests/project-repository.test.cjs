const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");
const {
  ProjectRepository,
  atomic,
} = require("../electron/project-repository.cjs");
const { InboxReceipts } = require("../electron/inbox-receipts.cjs");
const { fetchRemote, publicAddress } = require("../electron/fetch-remote.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weave-repo-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, "app");
  const repo = new ProjectRepository({ userData });
  const snapshot = repo.createProject({
    name: "测试项目",
    root: path.join(root, "project"),
  });
  return {
    root,
    userData,
    repo,
    projectId: snapshot.project.id,
    projectRoot: snapshot.project.root,
  };
}
const file = (name, text) => ({ name, bytes: [...Buffer.from(text)] });
const revisions = (assets) =>
  Object.fromEntries(assets.map((a) => [a.id, a.revision]));
test("desktop backup optionally includes trash and restores retained originals", (t) => {
  const f = fixture(t);
  let snap = f.repo.importFiles({ projectId: f.projectId, files: [file("留存.txt", "keep"), file("回收.txt", "trash")] });
  const trashed = snap.assets.find(a => a.name === "回收.txt");
  snap = f.repo.trashAssets({ projectId: f.projectId, ids: [trashed.id], revisions: revisions(snap.assets) });
  const complete = f.repo.safety.create(f.projectId);
  const partial = f.repo.safety.create(f.projectId, false);
  assert.equal(complete.trashCount, 1);
  assert.equal(partial.trashCount, 0);
  const fullRestored = f.repo.safety.restore({ projectId: f.projectId, backupId: complete.id, destination: path.join(f.root, "full") });
  const partialRestored = f.repo.safety.restore({ projectId: f.projectId, backupId: partial.id, destination: path.join(f.root, "partial") });
  assert.equal(fullRestored.assets.filter(a => a.trashedAt).length, 1);
  assert.equal(partialRestored.assets.length, 1);
  const recoveredTrash = fullRestored.assets.find(a => a.trashedAt);
  const returned = f.repo.restoreAssets({ projectId: fullRestored.project.id, ids: [recoveredTrash.id], revisions: revisions(fullRestored.assets) });
  assert.equal(returned.assets.find(a => a.id === recoveredTrash.id).trashedAt, undefined);
  assert.equal(fs.readFileSync(path.join(fullRestored.project.root, recoveredTrash.relativePath), "utf8"), "trash");
  assert.equal(f.repo.snapshot(f.projectId).assets.length, 2);
});
function importOne(f, name = "hello.txt", content = "Hello") {
  return f.repo.importFiles({
    projectId: f.projectId,
    files: [file(name, content)],
  });
}
function zipEntries(file) {
  const buffer = fs.readFileSync(file);
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0);
  let cursor = buffer.readUInt32LE(end + 16);
  const result = {};
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10);
    const size = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const local = buffer.readUInt32LE(cursor + 42);
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString();
    const start =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    const compressed = buffer.subarray(start, start + size);
    result[name] = method === 8 ? zlib.inflateRawSync(compressed) : compressed;
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}
test("native repository accepts Audio and Other with default audio recognition and persistent classification", (t) => {
  const f = fixture(t);
  f.repo.importFiles({
    projectId: f.projectId,
    files: [file("旁白.wav", "RIFFtestWAVE")],
  });
  let snapshot = f.repo.snapshot(f.projectId);
  const audio = snapshot.assets[0];
  assert.equal(audio.category, "audio");
  f.repo.updateAssets({
    projectId: f.projectId,
    ids: [audio.id],
    revisions: { [audio.id]: audio.revision },
    patch: { category: "other" },
  });
  snapshot = f.repo.snapshot(f.projectId);
  assert.equal(snapshot.assets[0].category, "other");
  const reopened = new ProjectRepository({ userData: f.userData });
  assert.equal(reopened.snapshot(f.projectId).assets[0].category, "other");
});

test("native project backup can be listed and restored as a verified independent copy", (t) => {
  const f = fixture(t);
  const imported = importOne(f, "画面.txt", "original");
  const backup = f.repo.safety.create(f.projectId);
  f.repo.updateAssets({
    projectId: f.projectId,
    ids: [imported.assets[0].id],
    revisions: { [imported.assets[0].id]: imported.assets[0].revision },
    patch: { name: "后来改名.txt" },
  });
  assert.equal(f.repo.safety.list(f.projectId)[0].id, backup.id);
  const restored = f.repo.safety.restore({
    projectId: f.projectId,
    backupId: backup.id,
    destination: path.join(f.root, "restored-copy"),
  });
  assert.notEqual(restored.project.id, f.projectId);
  assert.equal(restored.project.originProjectId, f.projectId);
  assert.equal(restored.project.name, "测试项目（恢复）");
  assert.equal(restored.assets[0].name, "画面.txt");
  assert.equal(f.repo.snapshot(f.projectId).assets[0].name, "后来改名.txt");
});

test("persistent registry, public inbox, redacted encrypted settings and portable entity files", (t) => {
  const f = fixture(t);
  const s = importOne(f);
  const a = s.assets[0];
  assert.equal(typeof a.size, "number");
  assert.equal(a.status, "candidate");
  assert.match(a.relativePath, /^media\/[a-f0-9-]{36}\.txt$/);
  assert.equal(a.source, "本地文件");
  assert.equal(
    a.hash,
    crypto.createHash("sha256").update("Hello").digest("hex"),
  );
  const stored = JSON.parse(
    fs.readFileSync(
      path.join(f.projectRoot, "metadata/assets", `${a.id}.json`),
    ),
  );
  assert.equal(stored.url, undefined);
  const second = new ProjectRepository({ userData: f.userData });
  assert.equal(second.bootstrap().snapshot.assets[0].id, a.id);
  const inbox = second.createProject({ name: "公共收件箱", publicInbox: true });
  assert.equal(
    second.createProject({ name: "anything", publicInbox: true }).project.id,
    inbox.project.id,
  );
  const encrypted = new ProjectRepository({
    userData: f.userData,
    encodeKey: (key) => `encrypted:${Buffer.from(key).toString("base64")}`,
  });
  encrypted.saveSettings({
    patch: {
      displayName: "Alice",
      api: { key: "SECRET", hasKey: false, enabled: true },
      lastSeen: { [f.projectId]: "2026-10-10T00:00:00Z" },
    },
  });
  const b = encrypted.bootstrap();
  assert.equal(b.settings.api.key, undefined);
  assert.equal(b.settings.api.encryptedKey, undefined);
  assert.equal(b.settings.api.hasKey, true);
  assert.equal(b.settings.deviceId, second.deviceId);
  assert.ok(
    !fs
      .readFileSync(path.join(f.userData, "settings.json"), "utf8")
      .includes("SECRET"),
  );
  assert.throws(() => encrypted.saveSettings({ patch: { deviceId: "fake" } }), {
    code: "INVALID",
  });
});
test("content dedup, folder copy preserves sources, counts and no activity for duplicate-only import", (t) => {
  const f = fixture(t);
  const folder = path.join(f.root, "input");
  fs.mkdirSync(path.join(folder, "nested"), { recursive: true });
  fs.writeFileSync(path.join(folder, "a.md"), "same");
  fs.writeFileSync(path.join(folder, "nested/b.txt"), "same");
  fs.writeFileSync(path.join(folder, "ignore.exe"), "ignored");
  let s = f.repo.importFiles({ projectId: f.projectId, paths: [folder] });
  assert.equal(s.importedCount, 1);
  assert.equal(s.duplicateCount, 1);
  assert.equal(s.assets.length, 1);
  assert.equal(fs.readFileSync(path.join(folder, "a.md"), "utf8"), "same");
  const count = s.activities.length;
  s = f.repo.importFiles({ projectId: f.projectId, paths: [folder] });
  assert.equal(s.importedCount, 0);
  assert.equal(s.duplicateCount, 2);
  assert.equal(s.activities.length, count);
  s = f.repo.trashAssets({
    projectId: f.projectId,
    ids: s.assets.map((a) => a.id),
    revisions: revisions(s.assets),
  });
  const dup = f.repo.importFiles({
    projectId: f.projectId,
    files: [file("same.md", "same")],
  });
  assert.equal(dup.importedCount, 0);
  assert.ok(dup.assets[0].trashedAt);
});
test("large path video imports use bounded buffers and preserve source", (t) => {
  const f = fixture(t);
  const input = path.join(f.root, "large.mp4");
  const fd = fs.openSync(input, "w");
  fs.ftruncateSync(fd, 101 * 1024 * 1024);
  fs.closeSync(fd);
  const originalRead = fs.readFileSync;
  fs.readFileSync = function (target, ...args) {
    if (target === input) throw new Error("Must not buffer source media");
    return originalRead.call(this, target, ...args);
  };
  try {
    const s = f.repo.importFiles({ projectId: f.projectId, paths: [input] });
    assert.equal(s.assets[0].size, 101 * 1024 * 1024);
    assert.equal(fs.statSync(input).size, s.assets[0].size);
  } finally {
    fs.readFileSync = originalRead;
  }
});
test("optimistic batch revision failures make no partial metadata edits", (t) => {
  const f = fixture(t);
  let s = f.repo.importFiles({
    projectId: f.projectId,
    files: [file("a.txt", "a"), file("b.txt", "b")],
  });
  const [a, b] = s.assets;
  s = f.repo.updateAssets({
    projectId: f.projectId,
    ids: [b.id],
    patch: { prompt: "new" },
    revisions: { [b.id]: 1 },
  });
  const count = s.activities.length;
  assert.throws(
    () =>
      f.repo.updateAssets({
        projectId: f.projectId,
        ids: [a.id, b.id],
        patch: { status: "final" },
        revisions: { [a.id]: 1, [b.id]: 1 },
      }),
    { code: "CONFLICT" },
  );
  s = f.repo.snapshot(f.projectId);
  assert.equal(s.assets.find((v) => v.id === a.id).status, "candidate");
  assert.equal(s.activities.length, count);
  assert.throws(
    () =>
      f.repo.updateAssets({
        projectId: f.projectId,
        ids: [a.id],
        patch: { relativePath: "../secret" },
        revisions: { [a.id]: 1 },
      }),
    { code: "INVALID" },
  );
  assert.throws(
    () =>
      f.repo.updateAssets({
        projectId: f.projectId,
        ids: [a.id],
        patch: { width: 0 },
        revisions: { [a.id]: 1 },
      }),
    { code: "INVALID" },
  );
  s = f.repo.updateAssets({
    projectId: f.projectId,
    ids: [a.id],
    patch: {
      width: 100,
      height: 200,
      duration: 0,
      tags: ["x", "x"],
      status: "final",
    },
    revisions: { [a.id]: 1 },
  });
  assert.deepEqual(s.assets.find((v) => v.id === a.id).tags, ["x"]);
});
test("one original can be reused across shots, duplicate receive links without copying, trash restores every reference", (t) => {
  const f = fixture(t);
  let s = f.repo.createShot({ projectId: f.projectId, title: "First" });
  const firstId = s.shots[0].id;
  s = f.repo.createShot({ projectId: f.projectId, title: "Second" });
  const secondId = s.shots.find((shot) => shot.title === "Second").id;
  s = f.repo.importFiles({
    projectId: f.projectId,
    files: [file("reference.txt", "same original")],
    shotId: firstId,
  });
  const asset = s.assets[0];
  s = f.repo.importFiles({
    projectId: f.projectId,
    files: [file("reference-again.txt", "same original")],
    shotId: secondId,
  });
  assert.equal(s.assets.length, 1);
  assert.equal(s.importedCount, 0);
  assert.equal(s.duplicateCount, 1);
  assert.equal(s.linkedCount, 1);
  assert.deepEqual(s.shots.find((shot) => shot.id === firstId).assetIds, [
    asset.id,
  ]);
  assert.deepEqual(s.shots.find((shot) => shot.id === secondId).assetIds, [
    asset.id,
  ]);
  s = f.repo.trashAssets({
    projectId: f.projectId,
    ids: [asset.id],
    revisions: revisions(s.assets),
  });
  assert.ok(s.shots.every((shot) => !shot.assetIds.includes(asset.id)));
  s = f.repo.restoreAssets({
    projectId: f.projectId,
    ids: [asset.id],
    revisions: revisions(s.assets),
  });
  assert.ok(s.shots.every((shot) => shot.assetIds.includes(asset.id)));
  const first = s.shots.find((shot) => shot.id === firstId);
  s = f.repo.updateShot({
    projectId: f.projectId,
    id: first.id,
    revision: first.revision,
    patch: { assetIds: [] },
  });
  assert.deepEqual(s.shots.find((shot) => shot.id === firstId).assetIds, []);
  assert.deepEqual(s.shots.find((shot) => shot.id === secondId).assetIds, [
    asset.id,
  ]);
  assert.equal(fs.readdirSync(path.join(f.projectRoot, "media")).length, 1);
});

test("trash removes references; restore reattaches existing shots; deleted shots retain tombstones", (t) => {
  const f = fixture(t);
  let s = f.repo.createShot({ projectId: f.projectId, title: "One" });
  const shot = s.shots[0];
  assert.equal(shot.order, 0);
  s = f.repo.createShot({ projectId: f.projectId, title: "Two" });
  assert.equal(s.shots.find((v) => v.title === "Two").order, 1);
  s = f.repo.importFiles({
    projectId: f.projectId,
    files: [file("one.txt", "one")],
    shotId: shot.id,
  });
  const a = s.assets[0];
  s = f.repo.updateShot({
    projectId: f.projectId,
    id: shot.id,
    patch: { assetIds: [a.id], dialogue: "Hello" },
    revision: s.shots.find((v) => v.id === shot.id).revision,
  });
  s = f.repo.trashAssets({
    projectId: f.projectId,
    ids: [a.id],
    revisions: { [a.id]: a.revision },
  });
  assert.equal(s.assets[0].shotId, undefined);
  assert.deepEqual(s.shots.find((v) => v.id === shot.id).assetIds, []);
  assert.throws(
    () => f.repo.resolveAsset({ projectId: f.projectId, id: a.id }),
    { code: "NOT_FOUND" },
  );
  s = f.repo.restoreAssets({
    projectId: f.projectId,
    ids: [a.id],
    revisions: revisions(s.assets),
  });
  assert.equal(s.assets[0].shotId, shot.id);
  assert.deepEqual(s.shots.find((v) => v.id === shot.id).assetIds, [a.id]);
  f.repo.saveSettings({
    patch: { receiveProjectId: f.projectId, receiveShotId: shot.id },
  });
  const current = s.shots.find((v) => v.id === shot.id);
  assert.throws(
    () =>
      f.repo.deleteShot({ projectId: f.projectId, id: shot.id, revision: 1 }),
    { code: "CONFLICT" },
  );
  s = f.repo.deleteShot({
    projectId: f.projectId,
    id: shot.id,
    revision: current.revision,
  });
  assert.equal(s.assets[0].shotId, undefined);
  assert.equal(f.repo.settings().receiveShotId, "");
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(f.projectRoot, "trash", `${shot.id}.json`)),
    ).shot.dialogue,
    "Hello",
  );
});
test("relocation rebinds root while live duplicate identity is rejected; unavailable bootstrap has warning", (t) => {
  const f = fixture(t);
  const s = importOne(f);
  const copy = path.join(f.root, "copy");
  fs.cpSync(f.projectRoot, copy, { recursive: true });
  assert.throws(() => f.repo.openProject({ path: copy }), {
    code: "DUPLICATE_PROJECT",
  });
  fs.rmSync(copy, { recursive: true });
  const moved = path.join(f.root, "relocated");
  fs.renameSync(f.projectRoot, moved);
  const unavailable = f.repo.bootstrap();
  assert.equal(unavailable.snapshot, undefined);
  assert.match(unavailable.warning, /当前项目暂不可用/);
  assert.equal(unavailable.projects[0].unavailable, true);
  const reopened = f.repo.openProject({ path: moved });
  assert.equal(reopened.assets[0].id, s.assets[0].id);
  assert.equal(
    f.repo.readDocument({ projectId: f.projectId, id: s.assets[0].id }).text,
    "Hello",
  );
});
test("read-only snapshots acquire no lock; interrupted journal replays atomically; dead local lock recovers", (t) => {
  const f = fixture(t);
  let s = importOne(f);
  const a = s.assets[0];
  const originalMkdir = fs.mkdirSync;
  fs.mkdirSync = function (target, ...args) {
    if (String(target).startsWith(f.projectRoot))
      throw Object.assign(new Error("Read-only"), { code: "EACCES" });
    return originalMkdir.call(this, target, ...args);
  };
  try {
    assert.equal(f.repo.snapshot(f.projectId).assets[0].id, a.id);
  } finally {
    fs.mkdirSync = originalMkdir;
  }
  const changed = { ...a, url: undefined, revision: 2, prompt: "Recovered" };
  const act = {
    id: crypto.randomUUID(),
    type: "test",
    deviceId: f.repo.deviceId,
    createdAt: new Date().toISOString(),
  };
  atomic(path.join(f.projectRoot, ".weave-transaction.json"), {
    writes: [
      { file: `metadata/assets/${a.id}.json`, value: changed },
      { file: `activity/${act.id}.json`, value: act },
    ],
  });
  const lock = path.join(f.projectRoot, ".weave-lock");
  fs.mkdirSync(lock);
  atomic(path.join(lock, "owner.json"), {
    deviceId: f.repo.deviceId,
    pid: 2147483647,
  });
  s = f.repo.snapshot(f.projectId);
  assert.equal(s.assets[0].prompt, "Recovered");
  assert.ok(!fs.existsSync(lock));
  assert.ok(
    !fs.existsSync(path.join(f.projectRoot, ".weave-transaction.json")),
  );
  fs.mkdirSync(lock);
  atomic(path.join(lock, "owner.json"), {
    deviceId: "other-device",
    pid: 2147483647,
  });
  assert.throws(
    () =>
      f.repo.updateAssets({
        projectId: f.projectId,
        ids: [a.id],
        patch: { prompt: "unsafe" },
        revisions: { [a.id]: 2 },
      }),
    { code: "BUSY" },
  );
  assert.ok(fs.existsSync(lock));
  assert.equal(f.repo.snapshot(f.projectId).assets[0].prompt, "Recovered");
});
test("independent writer processes cannot overwrite the same observed revision", async (t) => {
  const f = fixture(t);
  const a = importOne(f).assets[0];
  const modulePath = require.resolve("../electron/project-repository.cjs");
  const script = `const {ProjectRepository}=require(${JSON.stringify(modulePath)});const r=new ProjectRepository({userData:${JSON.stringify(f.userData)}});try{r.updateAssets({projectId:${JSON.stringify(f.projectId)},ids:[${JSON.stringify(a.id)}],patch:{prompt:process.argv[1]},revisions:{[${JSON.stringify(a.id)}]:1}});console.log('OK')}catch(e){console.log(e.code)}`;
  const run = (value) =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["-e", script, value]);
      let output = "";
      p.stdout.on("data", (data) => (output += data));
      p.on("error", reject);
      p.on("close", (code) =>
        code === 0
          ? resolve(output.trim())
          : reject(new Error(`Child exited ${code}`)),
      );
    });
  const results = await Promise.all([run("Alice"), run("Bob")]);
  assert.equal(results.filter((v) => v === "OK").length, 1);
  assert.ok(results.includes("CONFLICT") || results.includes("BUSY"));
  assert.equal(f.repo.snapshot(f.projectId).assets[0].revision, 2);
});
test("transfer preserves metadata, dedups safely, checks observed revisions and only then trashes source", (t) => {
  const f = fixture(t);
  let s = importOne(f);
  let a = s.assets[0];
  s = f.repo.updateAssets({
    projectId: f.projectId,
    ids: [a.id],
    patch: {
      name: "Display name",
      category: "character",
      tags: ["tag"],
      prompt: "prompt",
      status: "final",
    },
    revisions: { [a.id]: 1 },
  });
  a = s.assets[0];
  const target = f.repo.createProject({
    name: "Target",
    root: path.join(f.root, "target"),
  }).project.id;
  assert.throws(
    () =>
      f.repo.transferAssets({
        projectId: f.projectId,
        ids: [a.id],
        targetProjectId: target,
        move: true,
        revisions: { [a.id]: 1 },
      }),
    { code: "CONFLICT" },
  );
  assert.equal(f.repo.snapshot(target).assets.length, 0);
  let result = f.repo.transferAssets({
    projectId: f.projectId,
    ids: [a.id],
    targetProjectId: target,
    move: false,
    revisions: { [a.id]: a.revision },
  });
  const b = result.targetSnapshot.assets[0];
  assert.equal(b.name, "Display name");
  assert.equal(b.prompt, "prompt");
  assert.equal(b.status, "final");
  assert.deepEqual(b.tags, ["tag"]);
  assert.equal(b.shotId, undefined);
  assert.equal(result.assetIds[a.id], b.id);
  assert.equal(result.assets[0].trashedAt, undefined);
  result = f.repo.transferAssets({
    projectId: f.projectId,
    ids: [a.id],
    targetProjectId: target,
    move: true,
    revisions: { [a.id]: a.revision },
  });
  assert.equal(result.targetSnapshot.assets.length, 1);
  assert.ok(result.assets[0].trashedAt);
  const another = f.repo.createProject({
    name: "Another",
    root: path.join(f.root, "another"),
  }).project.id;
  const asset = f.repo.importFiles({
    projectId: another,
    files: [file("copy.txt", "Hello")],
  }).assets[0];
  f.repo.trashAssets({
    projectId: target,
    ids: [b.id],
    revisions: { [b.id]: b.revision },
  });
  assert.throws(
    () =>
      f.repo.transferAssets({
        projectId: another,
        ids: [asset.id],
        targetProjectId: target,
        move: true,
        revisions: { [asset.id]: 1 },
      }),
    { code: "TARGET_TRASHED" },
  );
  assert.equal(f.repo.snapshot(another).assets[0].trashedAt, undefined);
});
test("folder and ZIP exports reopen independently, sanitize sources, contain scripts and respect selection", async (t) => {
  const f = fixture(t);
  let s = importOne(f);
  s = f.repo.createShot({ projectId: f.projectId, title: "Scene" });
  const shot = s.shots[0];
  f.repo.updateShot({
    projectId: f.projectId,
    id: shot.id,
    patch: {
      dialogue: "Export this dialogue",
      description: "Scene description",
    },
    revision: 1,
  });
  const destination = path.join(f.root, "exports");
  const include = {
    assets: true,
    originals: true,
    storyboard: true,
    scripts: true,
    videos: true,
  };
  const output = await f.repo.exportProject({
    projectId: f.projectId,
    destination,
    format: "folder",
    include,
    storyboardFiles: [file("board.png", "preview")],
  });
  const reopened = f.repo.openProject({ path: output.folderPath });
  assert.notEqual(reopened.project.id, f.projectId);
  assert.equal(reopened.project.originProjectId, f.projectId);
  assert.equal(reopened.assets.length, 1);
  assert.equal(reopened.shots[0].dialogue, "Export this dialogue");
  assert.ok(
    !fs
      .readFileSync(path.join(output.folderPath, "weave-manifest.json"), "utf8")
      .includes(f.root.replace(/\\/g, "\\\\")),
  );
  assert.equal(f.repo.root(f.projectId), f.projectRoot);
  const zip = await f.repo.exportProject({
    projectId: f.projectId,
    destination,
    format: "zip",
    include: { scripts: true, storyboard: false },
  });
  const entries = zipEntries(zip.zipPath);
  assert.ok(entries["weave.project.json"]);
  assert.ok(entries[`metadata/shots/${shot.id}.json`]);
  assert.match(entries["scripts/shots.md"].toString(), /Export this dialogue/);
  assert.ok(entries["media/"]);
  const extract = path.join(f.root, "extract");
  fs.mkdirSync(extract);
  for (const [name, data] of Object.entries(entries)) {
    const target = path.join(extract, name);
    if (name.endsWith("/")) fs.mkdirSync(target, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
  }
  assert.equal(
    f.repo.openProject({ path: extract }).shots[0].dialogue,
    "Export this dialogue",
  );
  const empty = await f.repo.exportProject({
    projectId: f.projectId,
    destination,
    format: "folder",
    include: {},
  });
  assert.equal(f.repo.openProject({ path: empty.folderPath }).assets.length, 0);
  await assert.rejects(
    f.repo.exportProject({
      projectId: f.projectId,
      destination,
      format: "folder",
      include: { storyboard: true },
      storyboardFiles: [file("../escape.png", "bad")],
    }),
    { code: "INVALID_PATH" },
  );
});
test("inbox baselines old files, receipts survive restart and target changes, failures stay retryable", (t) => {
  const f = fixture(t);
  const folder = path.join(f.root, "inbox");
  fs.mkdirSync(folder);
  const old = path.join(folder, "old.txt");
  fs.writeFileSync(old, "old");
  let inbox = new InboxReceipts(f.repo);
  inbox.baseline(folder);
  f.repo.saveSettings({ patch: { inboxPath: folder, receiveProjectId: "" } });
  assert.equal(inbox.receive(old), null);
  const fresh = path.join(folder, "new.txt");
  fs.writeFileSync(fresh, "new");
  const received = inbox.receive(fresh);
  assert.equal(received.assets.length, 1);
  const target = f.repo.createProject({
    name: "Target",
    root: path.join(f.root, "target"),
  }).project.id;
  inbox = new InboxReceipts(new ProjectRepository({ userData: f.userData }));
  assert.equal(inbox.receive(fresh), null);
  assert.equal(f.repo.snapshot(target).assets.length, 0);
  const retry = path.join(folder, "retry.txt");
  fs.writeFileSync(retry, "retry");
  f.repo.saveSettings({ patch: { receiveProjectId: crypto.randomUUID() } });
  assert.throws(() => inbox.receive(retry), { code: "NOT_FOUND" });
  assert.equal(inbox.known(inbox.receipt(retry).key), false);
  f.repo.saveSettings({ patch: { receiveProjectId: target } });
  assert.equal(inbox.receive(retry).assets.length, 1);
  assert.throws(() => inbox.validate(f.projectRoot), /不能/);
  assert.throws(() => inbox.validate(f.root), /不能/);
  assert.throws(
    () => inbox.validate(path.join(f.projectRoot, "media")),
    /不能/,
  );
});
test("collaborator deletion reconciles a stale receiving shot without losing downloads", (t) => {
  const f = fixture(t);
  const s = f.repo.createShot({ projectId: f.projectId, title: "Remote" });
  const shot = s.shots[0];
  f.repo.saveSettings({
    patch: { receiveProjectId: f.projectId, receiveShotId: shot.id },
  });
  const peer = new ProjectRepository({ userData: path.join(f.root, "peer") });
  peer.openProject({ path: f.projectRoot });
  peer.deleteShot({ projectId: f.projectId, id: shot.id, revision: 1 });
  assert.equal(f.repo.bootstrap().settings.receiveShotId, "");
  assert.notEqual(peer.deviceId, f.repo.settings().deviceId);
});
test("secure media paths reject traversal and remote fetching rejects file/local/private URLs", async (t) => {
  const f = fixture(t);
  const a = importOne(f).assets[0];
  const metadata = path.join(f.projectRoot, "metadata/assets", `${a.id}.json`);
  const value = JSON.parse(fs.readFileSync(metadata));
  value.relativePath = "../settings.json";
  atomic(metadata, value);
  assert.throws(
    () => f.repo.resolveAsset({ projectId: f.projectId, id: a.id }),
    { code: "INVALID_PATH" },
  );
  assert.equal(publicAddress("127.0.0.1"), false);
  assert.equal(publicAddress("::1"), false);
  assert.equal(publicAddress("::ffff:127.0.0.1"), false);
  assert.equal(publicAddress("10.1.2.3"), false);
  assert.equal(publicAddress("8.8.8.8"), true);
  await assert.rejects(fetchRemote({ url: "file:///etc/passwd" }), /HTTP/);
  await assert.rejects(
    fetchRemote({ url: "http://127.0.0.1/a.png" }),
    /Private/,
  );
  await assert.rejects(
    fetchRemote({ url: "https://user:password@example.com/a.png" }),
    /anonymous/,
  );
});
