const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ProjectSafety } = require("./project-safety.cjs");

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const fail = (code, message, extra = {}) => {
  throw Object.assign(new Error(message), { code, ...extra });
};
const idCheck = (id) => {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id))
    fail("INVALID", "Invalid entity ID");
  return id;
};
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${uuid()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function inside(root, relative) {
  if (
    typeof relative !== "string" ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").includes("..")
  )
    fail("INVALID_PATH", "Expected a project-relative path");
  const full = path.resolve(root, relative);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
    fail("INVALID_PATH", "Path escapes project");
  // Reject symlink/junction ancestors, including files created outside Weave.
  let cursor = full;
  while (cursor !== root) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
      fail("INVALID_PATH", "Linked project paths are not allowed");
    cursor = path.dirname(cursor);
  }
  return full;
}
const TYPES = {
  ".png": ["image", "image/png"],
  ".jpg": ["image", "image/jpeg"],
  ".jpeg": ["image", "image/jpeg"],
  ".webp": ["image", "image/webp"],
  ".gif": ["image", "image/gif"],
  ".bmp": ["image", "image/bmp"],
  ".avif": ["image", "image/avif"],
  ".mp4": ["video", "video/mp4"],
  ".mov": ["video", "video/quicktime"],
  ".webm": ["video", "video/webm"],
  ".mkv": ["video", "video/x-matroska"],
  ".avi": ["video", "video/x-msvideo"],
  ".mp3": ["audio", "audio/mpeg"],
  ".wav": ["audio", "audio/wav"],
  ".m4a": ["audio", "audio/mp4"],
  ".ogg": ["audio", "audio/ogg"],
  ".flac": ["audio", "audio/flac"],
  ".txt": ["document", "text/plain"],
  ".md": ["document", "text/markdown"],
  ".json": ["document", "application/json"],
  ".pdf": ["document", "application/pdf"],
  ".doc": ["document", "application/msword"],
  ".docx": [
    "document",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
};
const categories = [
  "uncategorized",
  "product",
  "character",
  "scene",
  "prop",
  "storyboard",
  "script",
  "video",
  "audio",
  "other",
];
const statuses = ["candidate", "final", "rejected"];
function enumValue(value, choices, label) {
  if (!choices.includes(value)) fail("INVALID", `Invalid ${label}`);
  return value;
}
function string(value, label, max = 100000) {
  if (typeof value !== "string" || value.length > max)
    fail("INVALID", `Invalid ${label}`);
  return value;
}
function bytes(value) {
  if (
    !Array.isArray(value) ||
    value.length > 100 * 1024 * 1024 ||
    value.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  )
    fail("INVALID", "Invalid bytes (100 MiB limit)");
  return Buffer.from(value);
}
function list(root, folder) {
  return fs
    .readdirSync(inside(root, folder))
    .filter((n) => /^[a-f0-9-]{36}\.json$/i.test(n))
    .map((n) => read(inside(root, `${folder}/${n}`)));
}
function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)))
      hash.update(buffer.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}
function saveMedia(root, relativePath, input, hash) {
  const target = inside(root, relativePath);
  const temp = `${target}.${uuid()}.tmp`;
  try {
    if (input.file)
      fs.copyFileSync(input.file, temp, fs.constants.COPYFILE_EXCL);
    else fs.writeFileSync(temp, input.data, { flag: "wx" });
    const fd = fs.openSync(temp, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (hashFile(temp) !== hash)
      fail("SOURCE_CHANGED", "Source changed while copying; retry import");
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function exportSource(source) {
  return typeof source === "string" && /^https?:\/\//i.test(source)
    ? source
    : "本地文件";
}

class ProjectRepository {
  constructor({
    userData,
    encodeKey,
    decodeKey,
    urlFor,
    appVersion = require("../package.json").version,
    protectedDirectories = [],
  } = {}) {
    if (!userData) fail("INVALID", "userData is required");
    this.userData = path.resolve(userData);
    this.appVersion = appVersion;
    this.protectedDirectories = protectedDirectories.map((dir) =>
      fs.realpathSync(dir),
    );
    this.safety = new ProjectSafety(this, {
      atomic,
      inside,
      hashFile,
      read,
      uuid,
      now,
    });
    fs.mkdirSync(this.userData, { recursive: true });
    this.encodeKey = encodeKey;
    this.decodeKey = decodeKey;
    this.urlFor =
      urlFor ||
      ((projectId, assetId) => `weave-media://asset/${projectId}/${assetId}`);
    this.registryFile = path.join(this.userData, "projects.json");
    this.settingsFile = path.join(this.userData, "settings.json");
    if (!fs.existsSync(this.registryFile))
      atomic(this.registryFile, { projects: [], deviceId: uuid() });
    if (!fs.existsSync(this.settingsFile))
      atomic(this.settingsFile, {
        displayName: "我",
        inboxPath: "",
        receiveProjectId: "",
        receiveShotId: "",
        notifications: true,
        background: false,
        lastSeen: {},
      });
    this.deviceId = this.registry().deviceId;
  }
  registry() {
    return read(this.registryFile);
  }
  settings() {
    const s = read(this.settingsFile);
    s.deviceId = this.deviceId;
    if (s.api) {
      s.api.hasKey = !!s.api.encryptedKey;
      delete s.api.encryptedKey;
      delete s.api.key;
    }
    return s;
  }
  saveSettings({ patch }) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
      fail("INVALID", "Invalid settings patch");
    return this.withLocalLock(() => {
      const s = read(this.settingsFile);
      for (const k of Object.keys(patch)) {
        const v = patch[k];
        if (
          [
            "displayName",
            "inboxPath",
            "receiveProjectId",
            "receiveShotId",
          ].includes(k)
        )
          s[k] = string(v, k, 4096);
        else if (["notifications", "background"].includes(k)) {
          if (typeof v !== "boolean") fail("INVALID", k);
          s[k] = v;
        } else if (k === "lastSeen") {
          if (!v || typeof v !== "object" || Array.isArray(v))
            fail("INVALID", k);
          for (const [id, date] of Object.entries(v)) {
            idCheck(id);
            if (!Number.isFinite(Date.parse(date)))
              fail("INVALID", "Invalid read marker");
          }
          s.lastSeen = { ...s.lastSeen, ...v };
        } else if (k === "mutedProjects") {
          if (!Array.isArray(v)) fail("INVALID", k);
          s[k] = v.map(idCheck);
        } else if (k === "api") {
          if (!v || typeof v !== "object" || Array.isArray(v))
            fail("INVALID", k);
          s.api = { ...s.api };
          for (const field of Object.keys(v)) {
            if (["baseUrl", "model"].includes(field))
              s.api[field] = string(v[field], field, 4096);
            else if (field === "enabled") {
              if (typeof v[field] !== "boolean") fail("INVALID", field);
              s.api.enabled = v[field];
            } else if (field === "key") {
              const key = string(v.key, "key", 8192);
              if (key && !this.encodeKey)
                fail(
                  "ENCRYPTION_UNAVAILABLE",
                  "Secure credential storage unavailable",
                );
              if (key) s.api.encryptedKey = this.encodeKey(key);
              else delete s.api.encryptedKey;
            } else if (field !== "hasKey")
              fail("INVALID", `Unknown API setting: ${field}`);
          }
        } else fail("INVALID", `Unknown setting: ${k}`);
      }
      atomic(this.settingsFile, s);
      return this.settings();
    });
  }
  withLocalLock(fn) {
    return this.lock(this.userData, fn, false);
  }
  lock(root, fn, recover = true) {
    const lock = path.join(root, ".weave-lock");
    try {
      fs.mkdirSync(lock);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let owner;
      try {
        owner = read(path.join(lock, "owner.json"));
      } catch {}
      let dead = false;
      if (
        owner?.deviceId === this.deviceId &&
        Number.isInteger(owner.pid) &&
        owner.pid > 0
      ) {
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          dead = error.code === "ESRCH";
        }
      }
      if (dead) {
        const guard = path.join(root, ".weave-recovery-lock");
        try {
          fs.mkdirSync(guard);
        } catch {
          fail("BUSY", "Another writer is recovering the project; retry");
        }
        try {
          // Re-check under the recovery guard before touching a possibly replaced lock.
          let latest;
          try {
            latest = read(path.join(lock, "owner.json"));
          } catch {}
          if (JSON.stringify(latest) !== JSON.stringify(owner))
            fail("BUSY", "Lock ownership changed; retry");
          const abandoned = path.join(root, `.weave-abandoned-${uuid()}`);
          try {
            fs.renameSync(lock, abandoned);
          } catch {
            fail("BUSY", "Another writer is recovering the project; retry");
          }
          fs.unlinkSync(path.join(abandoned, "owner.json"));
          fs.rmdirSync(abandoned);
        } finally {
          fs.rmdirSync(guard);
        }
        return this.lock(root, fn, recover);
      }
      fail(
        "BUSY",
        "项目正在写入，请稍后重试。若另一台设备已退出，请确认所有写入已停止，再手动移除 .weave-lock；不会自动删除跨设备锁。",
      );
    }
    try {
      atomic(path.join(lock, "owner.json"), {
        pid: process.pid,
        deviceId: this.deviceId,
        createdAt: now(),
      });
      if (recover) this.recover(root);
      return fn();
    } finally {
      fs.unlinkSync(path.join(lock, "owner.json"));
      fs.rmdirSync(lock);
    }
  }
  recover(root) {
    const journal = path.join(root, ".weave-transaction.json");
    if (!fs.existsSync(journal)) return;
    const { writes } = read(journal);
    if (!Array.isArray(writes)) fail("CORRUPT", "Invalid transaction journal");
    for (const w of writes) {
      if (
        w.file !== "metadata/editing.json" &&
        w.file !== "metadata/editing-history.json" &&
        w.file !== "metadata/canvas.json" &&
        !/^(metadata\/(assets|shots)|activity|trash)\/[a-f0-9-]{36}\.json$/.test(
          w.file,
        )
      )
        fail("CORRUPT", "Invalid transaction target");
      const target = inside(root, w.file);
      if (w.value === null) {
        if (fs.existsSync(target)) fs.unlinkSync(target);
      } else atomic(target, w.value);
    }
    fs.unlinkSync(journal);
  }
  commit(root, writes, type, fields = {}) {
    if (
      !writes.length &&
      !["project.created", "project.exported"].includes(type)
    )
      return;
    const messages = {
      "project.created": "创建项目",
      "project.exported": "导出项目",
      "assets.imported": "导入素材",
      "assets.updated": "更新素材",
      "assets.trashed": "移入回收站",
      "assets.restored": "恢复素材",
      "assets.transferred": "整理素材到项目",
      "shot.created": "创建镜头",
      "shot.updated": "更新镜头",
      "shot.deleted": "删除镜头",
    };
    const activity = {
      id: uuid(),
      actor: this.settings().displayName,
      deviceId: this.deviceId,
      type,
      message: `${messages[type] || type}${fields.assetIds ? `（${fields.assetIds.length} 项）` : ""}`,
      createdAt: now(),
      ...fields,
    };
    writes.push({ file: `activity/${activity.id}.json`, value: activity });
    atomic(path.join(root, ".weave-transaction.json"), { writes });
    this.recover(root);
  }
  root(projectId) {
    idCheck(projectId);
    const entry = this.registry().projects.find((p) => p.id === projectId);
    if (!entry) fail("NOT_FOUND", "Project is not registered");
    const root = fs.realpathSync(entry.root);
    const header = read(inside(root, "weave.project.json"));
    if (header.schemaVersion !== 1)
      fail(
        "UNSUPPORTED_SCHEMA",
        "工程格式比当前程序新或不受支持，原工程未修改。请使用兼容的软件打开。",
      );
    if (header.id !== projectId)
      fail("INVALID_PROJECT", "Project identity changed");
    return root;
  }
  project(root) {
    return { ...read(inside(root, "weave.project.json")), root };
  }
  listProjects() {
    return this.registry().projects.map((p) => {
      try {
        const root = this.root(p.id);
        const project = this.project(root);
        const assets = list(root, "metadata/assets");
        const shots = list(root, "metadata/shots");
        const editingPath = inside(root, "metadata/editing.json");
        const editing = fs.existsSync(editingPath) ? read(editingPath) : undefined;
        const canvasPath = inside(root, "metadata/canvas.json");
        const updatedAt = [
          project.createdAt,
          ...assets.map((asset) => asset.updatedAt),
          ...shots.map((shot) => shot.updatedAt),
          ...(fs.existsSync(editingPath) ? [fs.statSync(editingPath).mtime.toISOString()] : []),
          ...(fs.existsSync(canvasPath) ? [fs.statSync(canvasPath).mtime.toISOString()] : []),
        ].filter((value) => typeof value === "string").sort().pop();
        return {
          ...project,
          assetCount: assets.filter((asset) => !asset.trashedAt).length,
          paragraphCount: editing?.paragraphs?.length || 0,
          updatedAt,
        };
      } catch {
        return { ...p, unavailable: true };
      }
    });
  }
  register(root) {
    root = fs.realpathSync(root);
    this.safety.assertLocation(root);
    const project = this.project(root);
    idCheck(project.id);
    if (project.schemaVersion !== 1)
      fail("INVALID_PROJECT", "Unsupported project schema");
    const existing = this.registry().projects.find((p) => p.id === project.id);
    if (
      existing &&
      path.resolve(existing.root).toLowerCase() !== root.toLowerCase() &&
      fs.existsSync(path.join(existing.root, "weave.project.json"))
    )
      fail(
        "DUPLICATE_PROJECT",
        "此项目 ID 已在另一文件夹注册。请打开原项目，或使用导出创建独立副本；移动项目时请先移走原文件夹。",
      );
    for (const dir of [
      "media",
      "metadata/assets",
      "metadata/shots",
      "activity",
      "trash",
    ])
      fs.mkdirSync(inside(root, dir), { recursive: true });
    this.withLocalLock(() => {
      const r = this.registry();
      r.projects = [...r.projects.filter((p) => p.id !== project.id), project];
      r.activeProjectId = project.id;
      atomic(this.registryFile, r);
    });
    return project;
  }
  createProject({ name, root, publicInbox = false }) {
    name = string(name, "name", 200).trim();
    if (!name) fail("INVALID", "Project name is required");
    if (publicInbox) {
      const existing = this.registry().projects.find((p) => p.publicInbox);
      if (existing) return this.selectProject({ id: existing.id });
      root = path.join(this.userData, "public-inbox");
      name = "待整理";
      if (fs.existsSync(path.join(root, "weave.project.json")))
        return this.openProject({ path: root });
    }
    if (!root) fail("INVALID", "Project folder required");
    root = path.resolve(root);
    fs.mkdirSync(root, { recursive: true });
    root = fs.realpathSync(root);
    this.safety.assertLocation(root);
    if (fs.readdirSync(root).length)
      fail("EXISTS", "Choose an empty project folder");
    const project = {
      id: uuid(),
      name,
      schemaVersion: 1,
      createdAt: now(),
      ...(publicInbox ? { publicInbox: true } : {}),
    };
    atomic(inside(root, "weave.project.json"), project);
    this.register(root);
    this.safety.markCurrent(root);
    return this.mutate(project.id, (r) => {
      this.commit(r, [], "project.created");
    });
  }
  openProject(payload) {
    const input =
      typeof payload === "string" ? payload : payload.path || payload.root;
    if (!input) fail("INVALID", "Project path required");
    const root = path.extname(input) === ".json" ? path.dirname(input) : input;
    const p = this.register(root);
    return this.snapshot(p.id);
  }
  selectProject({ id }) {
    this.root(id);
    this.withLocalLock(() => {
      const r = this.registry();
      r.activeProjectId = id;
      atomic(this.registryFile, r);
    });
    return this.snapshot(id);
  }
  snapshotUnlocked(root) {
    const project = this.project(root);
    return {
      project,
      editing: fs.existsSync(inside(root, "metadata/editing.json"))
        ? read(inside(root, "metadata/editing.json"))
        : undefined,
      editingHistory: fs.existsSync(inside(root, "metadata/editing-history.json"))
        ? read(inside(root, "metadata/editing-history.json")) : undefined,
      canvas: fs.existsSync(inside(root, "metadata/canvas.json"))
        ? read(inside(root, "metadata/canvas.json")) : undefined,
      assets: list(root, "metadata/assets").map((a) => ({
        ...a,
        url: a.trashedAt ? undefined : this.urlFor(project.id, a.id),
      })),
      shots: list(root, "metadata/shots").sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
      activities: list(root, "activity").sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
    };
  }
  snapshot(id) {
    const root = this.root(id);
    const journal = path.join(root, ".weave-transaction.json");
    // Reading atomic files must not require write access to a shared project.
    if (fs.existsSync(journal)) this.lock(root, () => {});
    for (let attempt = 0; attempt < 3; attempt++) {
      if (fs.existsSync(journal))
        fail("BUSY", "Project transaction pending; retry shortly");
      const before = fs
        .readdirSync(inside(root, "activity"))
        .filter((n) => n.endsWith(".json"))
        .sort()
        .join("|");
      let snapshot;
      try {
        snapshot = this.snapshotUnlocked(root);
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      const after = fs
        .readdirSync(inside(root, "activity"))
        .filter((n) => n.endsWith(".json"))
        .sort()
        .join("|");
      if (!fs.existsSync(journal) && before === after) return snapshot;
    }
    fail("BUSY", "Project changed during read; refresh");
  }
  bootstrap() {
    const r = this.registry();
    let snapshot;
    let warning;
    if (r.activeProjectId) {
      try {
        snapshot = this.snapshot(r.activeProjectId);
      } catch (error) {
        warning = `当前项目暂不可用，请检查共享文件夹连接或重新打开项目。${error.code || "ERROR"}: ${error.message}`;
      }
    }
    this.reconcileReceiveShot(snapshot);
    return {
      projects: this.listProjects(),
      activeProjectId: r.activeProjectId,
      snapshot,
      ...(warning ? { warning } : {}),
      settings: this.settings(),
      capabilities: {
        portableProjects: true,
        revisions: true,
        trash: true,
        folderImport: true,
        exportZip: true,
        exportFolder: true,
        ai: false,
        encryptedKey: !!this.encodeKey,
        sqliteCache: false,
      },
    };
  }
  reconcileReceiveShot(activeSnapshot) {
    const settings = this.settings();
    if (!settings.receiveShotId) return;
    const projectId =
      settings.receiveProjectId || this.registry().activeProjectId;
    let snapshot =
      activeSnapshot?.project.id === projectId ? activeSnapshot : undefined;
    if (!snapshot) {
      try {
        snapshot = this.snapshot(projectId);
      } catch {
        return;
      }
    }
    if (!snapshot.shots.some((s) => s.id === settings.receiveShotId))
      this.saveSettings({ patch: { receiveShotId: "" } });
  }
  mutate(id, fn) {
    const root = this.root(id);
    return this.lock(root, () => {
      this.safety.assertLocation(root);
      this.safety.beforeWrite(root);
      fn(root);
      return this.snapshotUnlocked(root);
    });
  }
  expect(entity, revision) {
    if (!Number.isInteger(revision) || revision !== entity.revision)
      fail("CONFLICT", "Entity changed; refresh before retrying", {
        id: entity.id,
        expected: revision,
        actual: entity.revision,
      });
  }
  entity(root, kind, id) {
    const file = inside(root, `metadata/${kind}/${idCheck(id)}.json`);
    if (!fs.existsSync(file)) fail("NOT_FOUND", "Entity not found");
    return read(file);
  }
  validShot(root, id) {
    if (id) this.entity(root, "shots", id);
  }
  importFiles({
    projectId,
    files = [],
    paths = [],
    category = "uncategorized",
    shotId,
  }) {
    enumValue(category, categories, "category");
    if (!Array.isArray(files) || !Array.isArray(paths))
      fail("INVALID", "Expected file arrays");
    const inputs = files.map((f) => ({
      name: path.basename(string(f.name, "name", 255)),
      data: bytes(f.bytes),
      source:
        f.source === undefined
          ? "本地文件"
          : exportSource(string(f.source, "source", 8192)),
    }));
    const visit = (input) => {
      const stat = fs.lstatSync(input);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        for (const n of fs.readdirSync(input).sort())
          visit(path.join(input, n));
      } else if (stat.isFile() && TYPES[path.extname(input).toLowerCase()]) {
        if (stat.size > 16 * 1024 * 1024 * 1024)
          fail("TOO_LARGE", "File exceeds 16 GiB");
        inputs.push({
          name: path.basename(input),
          file: input,
          size: stat.size,
          source: "本地文件",
        });
      }
    };
    for (const input of paths) {
      string(input, "path", 8192);
      const absolute = path.resolve(input);
      const root = this.root(projectId);
      const rel = path.relative(root, absolute);
      if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel)))
        fail("INVALID", "Cannot recursively import the project into itself");
      visit(absolute);
    }
    let importedCount = 0,
      duplicateCount = 0,
      linkedCount = 0;
    const snapshot = this.mutate(projectId, (root) => {
      this.validShot(root, shotId);
      const existing = list(root, "metadata/assets");
      const hashes = new Set(existing.map((a) => a.hash));
      const writes = [];
      const added = [];
      const links = [];
      for (const input of inputs) {
        const ext = path.extname(input.name).toLowerCase();
        const type = TYPES[ext];
        if (!type) continue;
        const hash = input.file
          ? hashFile(input.file)
          : crypto.createHash("sha256").update(input.data).digest("hex");
        if (hashes.has(hash)) {
          duplicateCount++;
          const duplicate = existing.find(
            (a) => a.hash === hash && !a.trashedAt,
          );
          if (duplicate) links.push(duplicate.id);
          continue;
        }
        hashes.add(hash);
        const id = uuid();
        const relativePath = `media/${uuid()}${ext}`;
        saveMedia(root, relativePath, input, hash);
        const stamp = now();
        const asset = {
          id,
          name: input.name,
          relativePath,
          kind: type[0],
          category:
            category === "uncategorized" && type[0] === "audio"
              ? "audio"
              : category,
          size: input.file
            ? fs.statSync(inside(root, relativePath)).size
            : input.data.length,
          mime: type[1],
          createdAt: stamp,
          updatedAt: stamp,
          revision: 1,
          hash,
          source: input.source,
          prompt: "",
          tags: [],
          status: "candidate",
          ...(shotId ? { shotId } : {}),
        };
        writes.push({ file: `metadata/assets/${id}.json`, value: asset });
        added.push(id);
        links.push(id);
        importedCount++;
      }
      if (shotId && links.length) {
        const shot = this.entity(root, "shots", shotId);
        const previous =
          shot.assetIds ??
          existing
            .filter((a) => a.shotId === shotId && !a.trashedAt)
            .map((a) => a.id);
        const next = [...new Set([...previous, ...links])];
        linkedCount = next.length - previous.length;
        if (linkedCount)
          writes.push({
            file: `metadata/shots/${shotId}.json`,
            value: {
              ...shot,
              assetIds: next,
              revision: shot.revision + 1,
              updatedAt: now(),
            },
          });
      }
      this.commit(
        root,
        writes,
        added.length ? "assets.imported" : "shot.updated",
        {
          assetIds: added.length ? added : links,
          ...(shotId ? { shotId } : {}),
        },
      );
    });
    return { ...snapshot, importedCount, duplicateCount, linkedCount };
  }
  assetPatch(root, patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
      fail("INVALID", "Invalid asset patch");
    const result = {};
    for (const [k, v] of Object.entries(patch)) {
      if (["name", "prompt"].includes(k))
        result[k] = string(v, k, k === "name" ? 255 : 100000);
      else if (k === "category") result[k] = enumValue(v, categories, k);
      else if (k === "status") result[k] = enumValue(v, statuses, k);
      else if (k === "tags") {
        if (!Array.isArray(v) || v.length > 1000) fail("INVALID", k);
        result[k] = [...new Set(v.map((t) => string(t, "tag", 200)))];
      } else if (k === "shotId") {
        if (v !== null && v !== "") this.validShot(root, idCheck(v));
        result[k] = v || undefined;
      } else if (["width", "height", "duration"].includes(k)) {
        if (!Number.isFinite(v) || v < 0 || (k !== "duration" && v === 0))
          fail("INVALID", k);
        result[k] = v;
      } else fail("INVALID", `Unknown asset field: ${k}`);
    }
    return result;
  }
  updateAssets({ projectId, ids, patch, revisions }) {
    return this.mutate(projectId, (root) => {
      const valid = this.assetPatch(root, patch);
      const entities = this.assetsForEdit(root, ids, revisions);
      if (!Object.keys(valid).length) return;
      const writes = entities
        .filter((a) => !a.trashedAt)
        .map((a) => ({
          file: `metadata/assets/${a.id}.json`,
          value: { ...a, ...valid, revision: a.revision + 1, updatedAt: now() },
        }));
      this.reconcileStackFinals(root,writes,ids,revisions);
      if (valid.shotId !== undefined || Object.hasOwn(valid, "shotId"))
        this.detachReferences(
          root,
          entities.map((a) => a.id),
          writes,
        );
      this.commit(root, writes, "assets.updated", {
        assetIds: entities.map((a) => a.id),
      });
    });
  }
  assetsForEdit(root, ids, revisions) {
    if (!Array.isArray(ids) || ids.length > 10000)
      fail("INVALID", "Invalid IDs");
    return [...new Set(ids)].map((id) => {
      const a = this.entity(root, "assets", id);
      this.expect(a, revisions?.[id]);
      return a;
    });
  }
  reconcileStackFinals(root,writes,preferred,revisions) {
    const staged=new Map(writes.filter(write=>write.file.startsWith("metadata/assets/")).map(write=>[write.value.id,write.value]));
    const all=list(root,"metadata/assets").map(asset=>staged.get(asset.id)||asset);
    const groups=new Map();
    for(const asset of all)if(asset.stackId&&!asset.trashedAt&&asset.status==="final")groups.set(asset.stackId,[...(groups.get(asset.stackId)||[]),asset]);
    for(const group of groups.values())if(group.length>1){
      const winner=group.find(asset=>preferred.includes(asset.id))||group[0];
      for(const asset of group)if(asset.id!==winner.id){
        if(!staged.has(asset.id))this.expect(asset,revisions?.[asset.id]);
        const value={...asset,status:"candidate",revision:asset.revision+1,updatedAt:now()};
        const write=writes.find(write=>write.file===`metadata/assets/${asset.id}.json`);
        if(write)write.value=value;else writes.push({file:`metadata/assets/${asset.id}.json`,value});
      }
    }
  }
  detachReferences(root, ids, writes) {
    const affected = new Set(ids);
    for (const shot of list(root, "metadata/shots"))
      if (shot.assetIds?.some((id) => affected.has(id)))
        writes.push({
          file: `metadata/shots/${shot.id}.json`,
          value: {
            ...shot,
            assetIds: shot.assetIds.filter((id) => !affected.has(id)),
            revision: shot.revision + 1,
            updatedAt: now(),
          },
        });
  }
  trashAssets({ projectId, ids, revisions }) {
    return this.mutate(projectId, (root) => {
      const entities = this.assetsForEdit(root, ids, revisions).filter(
        (a) => !a.trashedAt,
      );
      const writes = [];
      for (const a of entities) {
        const stamp = now();
        writes.push(
          {
            file: `trash/${a.id}.json`,
            value: {
              id: a.id,
              trashedAt: stamp,
              shotId: a.shotId,
              shotReferences: list(root, "metadata/shots")
                .filter((s) => s.assetIds?.includes(a.id))
                .map((s) => s.id),
            },
          },
          {
            file: `metadata/assets/${a.id}.json`,
            value: {
              ...a,
              shotId: undefined,
              trashedAt: stamp,
              updatedAt: stamp,
              revision: a.revision + 1,
            },
          },
        );
      }
      this.detachReferences(
        root,
        entities.map((a) => a.id),
        writes,
      );
      this.commit(root, writes, "assets.trashed", {
        assetIds: entities.map((a) => a.id),
      });
    });
  }
  restoreAssets({ projectId, ids, revisions }) {
    return this.mutate(projectId, (root) => {
      const entities = this.assetsForEdit(root, ids, revisions).filter(
        (a) => a.trashedAt,
      );
      const writes = [];
      const shots = list(root, "metadata/shots");
      for (const a of entities) {
        const record = read(inside(root, `trash/${a.id}.json`));
        const shotId = shots.some((s) => s.id === record.shotId)
          ? record.shotId
          : undefined;
        writes.push(
          {
            file: `metadata/assets/${a.id}.json`,
            value: {
              ...a,
              shotId,
              trashedAt: undefined,
              updatedAt: now(),
              revision: a.revision + 1,
            },
          },
          { file: `trash/${a.id}.json`, value: null },
        );
        for (const s of shots)
          if (record.shotReferences?.includes(s.id))
            s.assetIds = [...new Set([...(s.assetIds || []), a.id])];
      }
      for (const s of shots) {
        const old = this.entity(root, "shots", s.id);
        if (JSON.stringify(old.assetIds) !== JSON.stringify(s.assetIds))
          writes.push({
            file: `metadata/shots/${s.id}.json`,
            value: { ...s, revision: s.revision + 1, updatedAt: now() },
          });
      }
      this.reconcileStackFinals(root,writes,list(root,"metadata/assets").filter(asset=>!asset.trashedAt&&asset.status==="final").map(asset=>asset.id),revisions);
      this.commit(root, writes, "assets.restored", {
        assetIds: entities.map((a) => a.id),
      });
    });
  }
  async editAssetStack({ projectId, action, revisions }) {
    const { applyStackEdit, syncStackLinks } = await import(
      "../shared/asset-stacks.mjs"
    );
    const { validateEditing } = await import("../shared/editing.mjs");
    return this.mutate(projectId, (root) => {
      const result = applyStackEdit(
        list(root, "metadata/assets"),
        action,
        revisions,
      );
      const writes = result.changedIds.map((id) => ({
        file: `metadata/assets/${id}.json`,
        value: result.assets.find((asset) => asset.id === id),
      }));
      const editingPath = inside(root, "metadata/editing.json");
      if (fs.existsSync(editingPath)) {
        const doc = read(editingPath),
          next = syncStackLinks(doc, result.assets);
        if (next !== doc)
          writes.push({
            file: "metadata/editing.json",
            value: validateEditing(next, result.assets),
          });
      }
      this.commit(root, writes, "assets.stacked", {
        assetIds: result.changedIds,
      });
    });
  }
  async saveCanvas({ projectId, canvas, revision }) {
    const { saveCanvas } = await import("../shared/canvas.mjs");
    const result = this.mutate(projectId, (root) => {
      const snapshot = this.snapshotUnlocked(root);
      const next = saveCanvas(snapshot.canvas, canvas, snapshot.assets, revision);
      this.commit(root, [{ file: "metadata/canvas.json", value: next }], "canvas.updated");
    });
    return result.canvas;
  }
  async editReference({ projectId, action, revision }) {
    const { applyEditing } = await import("../shared/editing.mjs");
    const { rememberEditingVersion } = await import("../shared/editing-history.mjs");
    return this.mutate(projectId, (root) => {
      const snapshot = this.snapshotUnlocked(root);
      const editing = applyEditing(
        snapshot.editing,
        action,
        snapshot.assets,
        snapshot.shots,
        revision,
      );
      this.commit(
        root,
        [{ file: "metadata/editing.json", value: editing },
          { file: "metadata/editing-history.json", value: rememberEditingVersion(snapshot.editingHistory, snapshot.editing, action) }],
        "editing.updated",
      );
    });
  }
  createShot({ projectId, title }) {
    return this.mutate(projectId, (root) => {
      const stamp = now();
      const order =
        Math.max(
          -1,
          ...list(root, "metadata/shots").map((s, i) => s.order ?? i),
        ) + 1;
      const s = {
        id: uuid(),
        title: string(title, "title", 1000),
        description: "",
        dialogue: "",
        duration: 0,
        prompt: "",
        status: "draft",
        order,
        revision: 1,
        createdAt: stamp,
        updatedAt: stamp,
      };
      this.commit(
        root,
        [{ file: `metadata/shots/${s.id}.json`, value: s }],
        "shot.created",
        { shotId: s.id },
      );
    });
  }
  updateShot({ projectId, id, patch, revision }) {
    return this.mutate(projectId, (root) => {
      const s = this.entity(root, "shots", id);
      this.expect(s, revision);
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        fail("INVALID", "Invalid shot patch");
      const valid = {};
      for (const [k, v] of Object.entries(patch)) {
        if (["title", "description", "dialogue", "prompt"].includes(k))
          valid[k] = string(v, k);
        else if (["duration", "order"].includes(k)) {
          if (!Number.isFinite(v) || v < 0) fail("INVALID", k);
          valid[k] = v;
        } else if (k === "status")
          valid[k] = enumValue(
            v,
            ["draft", "image", "video", "review", "done"],
            k,
          );
        else if (k === "assetIds") {
          if (!Array.isArray(v)) fail("INVALID", k);
          valid[k] = [...new Set(v)].map((assetId) => {
            const a = this.entity(root, "assets", assetId);
            if (a.trashedAt)
              fail("INVALID", "Trashed asset cannot belong to storyboard");
            return a.id;
          });
        } else fail("INVALID", `Unknown shot field: ${k}`);
      }
      if (!Object.keys(valid).length) return;
      this.commit(
        root,
        [
          {
            file: `metadata/shots/${id}.json`,
            value: {
              ...s,
              ...valid,
              revision: s.revision + 1,
              updatedAt: now(),
            },
          },
        ],
        "shot.updated",
        { shotId: id },
      );
    });
  }
  deleteShot({ projectId, id, revision }) {
    const snapshot = this.mutate(projectId, (root) => {
      const s = this.entity(root, "shots", id);
      this.expect(s, revision);
      const writes = [
        {
          file: `trash/${id}.json`,
          value: { id, kind: "shot", shot: s, deletedAt: now() },
        },
        { file: `metadata/shots/${id}.json`, value: null },
      ];
      for (const a of list(root, "metadata/assets"))
        if (a.shotId === id)
          writes.push({
            file: `metadata/assets/${a.id}.json`,
            value: {
              ...a,
              shotId: undefined,
              revision: a.revision + 1,
              updatedAt: now(),
            },
          });
      this.commit(root, writes, "shot.deleted", { shotId: id });
    });
    this.reconcileReceiveShot(snapshot);
    return snapshot;
  }
  transferAssets({ projectId, ids, targetProjectId, move = false, revisions }) {
    if (typeof move !== "boolean" || projectId === targetProjectId)
      fail("INVALID", "Choose a different target project");
    if (!Array.isArray(ids) || !ids.length)
      fail("INVALID", "Choose assets to transfer");
    const source = this.snapshot(projectId);
    const originals = [...new Set(ids)].map((id) => {
      idCheck(id);
      const a = source.assets.find((a) => a.id === id && !a.trashedAt);
      if (!a) fail("NOT_FOUND", "Source asset not found");
      this.expect(a, revisions?.[id]);
      return a;
    });
    const assetIds = {};
    const target = this.mutate(targetProjectId, (root) => {
      const assets = list(root, "metadata/assets");
      const writes = [];
      for (const a of originals) {
        let existing = assets.find((b) => b.hash === a.hash);
        if (existing?.trashedAt)
          fail(
            "TARGET_TRASHED",
            "Target duplicate is in trash; restore it before transferring",
          );
        if (existing) {
          assetIds[a.id] = existing.id;
          continue;
        }
        const { file } = this.resolveAsset({ projectId, id: a.id });
        const id = uuid();
        const relativePath = `media/${uuid()}${path.extname(a.relativePath)}`;
        saveMedia(root, relativePath, { file }, a.hash);
        const stamp = now();
        const value = {
          ...a,
          id,
          relativePath,
          source: exportSource(a.source),
          shotId: undefined,
          url: undefined,
          revision: 1,
          createdAt: stamp,
          updatedAt: stamp,
        };
        writes.push({ file: `metadata/assets/${id}.json`, value });
        assets.push(value);
        assetIds[a.id] = id;
      }
      if (writes.length)
        this.commit(root, writes, "assets.transferred", {
          assetIds: Object.values(assetIds),
        });
    });
    // Target remains usable if source revisions conflict; do not lose edited originals.
    let result = source;
    if (move)
      result = this.trashAssets({
        projectId,
        ids: originals.map((a) => a.id),
        revisions: Object.fromEntries(originals.map((a) => [a.id, a.revision])),
      });
    return { ...result, targetSnapshot: target, assetIds };
  }
  resolveAsset({ projectId, id }) {
    const root = this.root(projectId);
    const a = this.entity(root, "assets", id);
    if (a.trashedAt) fail("NOT_FOUND", "Asset is in trash");
    if (!/^media\/[a-f0-9-]{36}\.[a-z0-9]+$/i.test(a.relativePath))
      fail("INVALID_PATH", "Invalid media path");
    const file = inside(root, a.relativePath);
    if (!fs.statSync(file).isFile()) fail("INVALID_PATH", "Not a media file");
    return { file, asset: a };
  }
  readDocument(payload) {
    const { file, asset } = this.resolveAsset(payload);
    if (
      !["text/plain", "text/markdown", "application/json"].includes(asset.mime)
    )
      fail(
        "UNSUPPORTED",
        "Only text, Markdown and JSON documents can be read as text",
      );
    if (fs.statSync(file).size > 2 * 1024 * 1024)
      fail("TOO_LARGE", "Document exceeds 2 MiB");
    return {
      name: asset.name,
      mime: asset.mime,
      text: fs.readFileSync(file, "utf8"),
    };
  }
  async exportProject({
    projectId,
    include = {},
    format = "zip",
    storyboardFiles = [],
    destination,
  }) {
    if (!["zip", "folder"].includes(format) || !destination)
      fail("INVALID", "Export format and destination required");
    if (
      !include ||
      typeof include !== "object" ||
      Object.keys(include).some(
        (k) =>
          !["assets", "originals", "storyboard", "scripts", "videos"].includes(
            k,
          ) || typeof include[k] !== "boolean",
      )
    )
      fail("INVALID", "Invalid export selection");
    const snapshot = this.snapshot(projectId);
    const root = snapshot.project.root;
    const dest = path.resolve(destination);
    fs.mkdirSync(dest, { recursive: true });
    const realDest = fs.realpathSync(dest);
    const rel = path.relative(root, realDest);
    if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel)))
      fail("INVALID", "Export outside the source project");
    const selected = snapshot.assets.filter(
      (a) =>
        !a.trashedAt &&
        ((a.kind === "video" && include.videos) ||
          ((a.category === "script" || a.kind === "document") &&
            include.scripts) ||
          (a.kind === "image" && include.assets) ||
          (a.kind === "audio" && include.assets) ||
          include.originals),
    );
    const exportedShots =
      include.storyboard || include.scripts
        ? snapshot.shots.map((s) => ({
            ...s,
            assetIds: s.assetIds?.filter((id) =>
              selected.some((a) => a.id === id),
            ),
          }))
        : [];
    const clean = (a) => {
      const { url, ...rest } = a;
      return {
        ...rest,
        source: exportSource(a.source),
        shotId: exportedShots.some((s) => s.id === a.shotId)
          ? a.shotId
          : undefined,
      };
    };
    const manifest = {
      product: "Weave",
      exportedAt: now(),
      project: {
        ...snapshot.project,
        id: uuid(),
        originProjectId: snapshot.project.id,
        root: undefined,
        publicInbox: undefined,
      },
      include,
      assets: selected.map(clean),
      shots: exportedShots,
    };
    const entries = [
      {
        name: "weave-manifest.json",
        data: Buffer.from(JSON.stringify(manifest, null, 2)),
      },
      {
        name: "weave.project.json",
        data: Buffer.from(JSON.stringify(manifest.project, null, 2)),
      },
    ];
    if (snapshot.canvas) {
      const { canvasForExport } = await import("../shared/canvas.mjs");
      const canvas = canvasForExport(snapshot.canvas, selected.map(a => a.id));
      manifest.canvas = canvas;
      entries[0].data = Buffer.from(JSON.stringify(manifest, null, 2));
      entries.push({ name: "metadata/canvas.json", data: Buffer.from(JSON.stringify(canvas, null, 2)) });
    }
    if (include.scripts && snapshot.editing) {
      const { editingForExport } = await import("../shared/editing.mjs");
      const editing = editingForExport(
        snapshot.editing,
        selected.map((a) => a.id),
      );
      manifest.editing = editing;
      entries[0].data = Buffer.from(JSON.stringify(manifest, null, 2));
      entries.push({
        name: "metadata/editing.json",
        data: Buffer.from(JSON.stringify(editing, null, 2)),
      });
    }
    for (const a of manifest.assets)
      entries.push({
        name: `metadata/assets/${a.id}.json`,
        data: Buffer.from(JSON.stringify(a, null, 2)),
      });
    for (const s of exportedShots)
      entries.push({
        name: `metadata/shots/${s.id}.json`,
        data: Buffer.from(JSON.stringify(s, null, 2)),
      });
    if (include.scripts)
      entries.push({
        name: "scripts/shots.md",
        data: Buffer.from(
          snapshot.shots
            .map(
              (s) =>
                `# ${s.title}\n\n${s.description}\n\n${s.dialogue}\n\n提示词：${s.prompt}\n\n时长：${s.duration}\n`,
            )
            .join("\n"),
        ),
      });
    if (include.storyboard) {
      if (!Array.isArray(storyboardFiles))
        fail("INVALID", "Invalid storyboard files");
      for (const f of storyboardFiles) {
        const name = string(f.name, "name", 255);
        if (
          name !== path.basename(name) ||
          /[\\/:*?"<>|]/.test(name) ||
          name === "." ||
          name === ".."
        )
          fail("INVALID_PATH", "Invalid storyboard filename");
        const entryName = `storyboard/${name}`;
        if (entries.some((e) => e.name === entryName))
          fail("INVALID", "Duplicate storyboard filename");
        entries.push({ name: entryName, data: bytes(f.bytes) });
      }
    }
    for (const a of selected)
      entries.push({
        name: a.relativePath,
        file: this.resolveAsset({ projectId, id: a.id }).file,
      });
    const safeName =
      snapshot.project.name
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
        .replace(/[. ]+$/g, "") || "Weave";
    const output = path.join(
      realDest,
      `${safeName}-${uuid()}${format === "zip" ? ".zip" : ""}`,
    );
    const staging = `${output}.partial`;
    try {
      if (format === "folder") {
        fs.mkdirSync(staging);
        for (const dir of [
          "media",
          "metadata/assets",
          "metadata/shots",
          "activity",
          "trash",
        ])
          fs.mkdirSync(inside(staging, dir), { recursive: true });
        for (const e of entries) {
          const target = inside(staging, e.name);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (e.file)
            fs.copyFileSync(e.file, target, fs.constants.COPYFILE_EXCL);
          else fs.writeFileSync(target, e.data, { flag: "wx" });
        }
      } else {
        const archiver = require("archiver");
        await new Promise((resolve, reject) => {
          const stream = fs.createWriteStream(staging, { flags: "wx" });
          const archive = archiver("zip", { zlib: { level: 6 } });
          const abort = (error) => {
            archive.abort();
            stream.destroy();
            reject(error);
          };
          stream.on("close", resolve);
          stream.on("error", abort);
          archive.on("error", abort);
          archive.on("warning", abort);
          archive.pipe(stream);
          for (const dir of [
            "media",
            "metadata/assets",
            "metadata/shots",
            "activity",
            "trash",
          ])
            archive.append("", { name: `${dir}/` });
          for (const e of entries) {
            if (e.file) archive.file(e.file, { name: e.name });
            else archive.append(e.data, { name: e.name });
          }
          archive.finalize().catch(abort);
        });
      }
      fs.renameSync(staging, output);
    } catch (e) {
      if (fs.existsSync(staging))
        fs.rmSync(staging, { recursive: true, force: true });
      throw e;
    }
    this.mutate(projectId, (r) => this.commit(r, [], "project.exported"));
    return {
      ok: true,
      destination: realDest,
      path: output,
      ...(format === "zip" ? { zipPath: output } : { folderPath: output }),
    };
  }
}
module.exports = { ProjectRepository, atomic, inside, TYPES };
