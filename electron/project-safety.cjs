const fs = require("node:fs");
const path = require("node:path");

class ProjectSafety {
  constructor(repo, helpers) { this.repo = repo; Object.assign(this, helpers); }
  assertLocation(root) {
    for (const protectedRoot of this.repo.protectedDirectories) {
      const relative = path.relative(protectedRoot, root);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)))
        throw new Error("工程不能保存在程序安装或更新目录内，请选择独立的工程文件夹。原文件未修改。");
    }
  }
  base(root) {
    const project = this.repo.project(root);
    return this.inside(path.dirname(root), `.weave-backups/${project.id}`);
  }
  walk(root, relative = "") {
    const files = [];
    for (const entry of fs.readdirSync(relative ? this.inside(root, relative) : root, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("工程或备份包含链接，备份已停止，不会修改原工程。");
      if (entry.isDirectory()) files.push(...this.walk(root, name));
      else if (entry.isFile()) files.push(name);
      else throw new Error("工程中存在不支持的文件类型");
    }
    return files;
  }
  markCurrent(root, backupId) {
    this.repo.withLocalLock(() => {
      const file = path.join(this.repo.userData, "upgrade-receipts.json");
      const receipts = fs.existsSync(file) ? this.read(file) : {};
      receipts[root] = { appVersion: this.repo.appVersion, checkedAt: this.now(), ...(backupId ? { backupId } : {}) };
      this.atomic(file, receipts);
    });
  }
  beforeWrite(root) {
    const file = path.join(this.repo.userData, "upgrade-receipts.json");
    const receipts = fs.existsSync(file) ? this.read(file) : {};
    if (receipts[root]?.appVersion === this.repo.appVersion) return;
    const backup = this.backupUnlocked(root, "更新前自动备份");
    this.markCurrent(root, backup.id);
  }
  backupUnlocked(root, reason, includeTrash = true) {
    const project = this.repo.project(root);
    const id = this.uuid(), base = this.base(root);
    fs.mkdirSync(base, { recursive: true });
    const staging = this.inside(base, `.partial-${id}`), destination = this.inside(base, id);
    fs.mkdirSync(staging);
    try {
      let files = ["weave.project.json"];
      for (const dir of ["media", "metadata", "activity", "trash"])
        if (fs.existsSync(this.inside(root, dir))) files.push(...this.walk(root, dir));
      const allAssets = files.filter(name => /^metadata\/assets\/.+\.json$/.test(name)).map(name => this.read(this.inside(root, name)));
      const removed = new Set(includeTrash ? [] : allAssets.filter(asset => asset.trashedAt).map(asset => asset.id));
      const activePaths = new Set(allAssets.filter(asset => !removed.has(asset.id)).map(asset => asset.relativePath));
      const omittedPaths = new Set(allAssets.filter(asset => removed.has(asset.id) && !activePaths.has(asset.relativePath)).map(asset => asset.relativePath));
      files = files.filter(name => !omittedPaths.has(name) && ![...removed].some(assetId => name === `metadata/assets/${assetId}.json` || name === `trash/${assetId}.json`));
      const cleanDocument = doc => { for (const paragraph of [...(doc?.paragraphs || []), ...(doc?.removed || []).map(item => item.paragraph)]) paragraph.links = paragraph.links.filter(link => !removed.has(link.assetId)); };
      const transform = (name, value) => {
        if (name === "metadata/editing.json") cleanDocument(value);
        else if (name === "metadata/editing-history.json") for (const entry of value) cleanDocument(entry.document);
        else if (name === "metadata/canvas.json") value.nodes = value.nodes.filter(node => node.kind !== "asset" || !removed.has(node.assetId));
        else if (/^metadata\/shots\/.+\.json$/.test(name) && value.assetIds) value.assetIds = value.assetIds.filter(assetId => !removed.has(assetId));
        return value;
      };
      const manifest = { format: "weave-folder-backup", backupVersion: 1, appVersion: this.repo.appVersion, id, projectId: project.id, name: project.name, createdAt: this.now(), reason, includeTrash, trashCount: allAssets.filter(asset => asset.trashedAt && !removed.has(asset.id)).length, assetCount: 0, size: 0, files: [] };
      for (const name of files) {
        const source = this.inside(root, name), target = this.inside(staging, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const needsTransform = removed.size && (name === "metadata/editing.json" || name === "metadata/editing-history.json" || name === "metadata/canvas.json" || /^metadata\/shots\/.+\.json$/.test(name));
        if (needsTransform) fs.writeFileSync(target, JSON.stringify(transform(name, this.read(source)), null, 2), { flag: "wx" });
        else fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        const hash = this.hashFile(target), size = fs.statSync(target).size;
        if (!needsTransform && (this.hashFile(source) !== hash || fs.statSync(source).size !== size)) throw new Error(`备份文件校验失败：${name}`);
        // Windows FlushFileBuffers requires a writable handle. Only the newly
        // copied staging file is opened for writing, never the source project.
        const fd = fs.openSync(target, "r+");
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        manifest.files.push({ name, hash, size });
        manifest.size += size;
        if (/^metadata\/assets\/.+\.json$/.test(name)) manifest.assetCount++;
      }
      // Verify actual originals against the recorded asset hashes, including trash.
      for (const name of files.filter((name) => /^metadata\/assets\/.+\.json$/.test(name))) {
        const asset = this.read(this.inside(staging, name));
        const original = this.inside(staging, asset.relativePath);
        if (!fs.existsSync(original) || this.hashFile(original) !== asset.hash || fs.statSync(original).size !== asset.size)
          throw new Error(`备份缺少完整原片：${asset.name}`);
      }
      this.atomic(path.join(staging, "weave.backup.json"), manifest);
      fs.renameSync(staging, destination);
      return this.info(manifest, destination);
    } catch (error) {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true });
      throw error;
    }
  }
  info(manifest, location) {
    const { id, projectId, name, createdAt, reason, assetCount, size, trashCount, includeTrash } = manifest;
    return { id, projectId, name, createdAt, reason, assetCount, size, trashCount, includeTrash, path: location };
  }
  list(projectId) {
    const root = this.repo.root(projectId), base = this.base(root);
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base).filter((id) => /^[a-f0-9-]{36}$/i.test(id)).map((id) => {
      const location = this.inside(base, id), manifest = this.read(this.inside(location, "weave.backup.json"));
      if (manifest.format !== "weave-folder-backup" || manifest.id !== id || manifest.projectId !== projectId) throw new Error("备份清单不一致，请保留文件并联系维护者");
      return this.info(manifest, location);
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  create(projectId, includeTrash = true) {
    const root = this.repo.root(projectId);
    return this.repo.lock(root, () => this.backupUnlocked(root, includeTrash ? "手动完整备份" : "手动备份（不含回收站）", includeTrash));
  }
  restore({ projectId, backupId, destination }) {
    const backup = this.list(projectId).find((item) => item.id === backupId);
    if (!backup) throw new Error("备份不存在");
    const manifest = this.read(this.inside(backup.path, "weave.backup.json"));
    if (manifest.backupVersion !== 1 || !Array.isArray(manifest.files)) throw new Error("备份版本不受支持");
    destination = path.resolve(destination);
    this.assertLocation(destination);
    const realParent = fs.realpathSync(path.dirname(destination));
    if (path.join(realParent, path.basename(destination)).toLowerCase() !== destination.toLowerCase()) throw new Error("恢复位置不能包含目录链接");
    if (fs.existsSync(destination) && (fs.lstatSync(destination).isSymbolicLink() || fs.readdirSync(destination).length)) throw new Error("恢复必须选择空文件夹，原工程不会覆盖");
    if (destination === backup.path || destination.startsWith(backup.path + path.sep)) throw new Error("不能恢复到备份内部");
    const names = new Set();
    for (const entry of manifest.files) {
      if (names.has(entry.name) || !(entry.name === "weave.project.json" || /^(media|metadata|activity|trash)\//.test(entry.name))) throw new Error("备份文件清单无效");
      names.add(entry.name);
      const file = this.inside(backup.path, entry.name);
      if (fs.statSync(file).size !== entry.size || this.hashFile(file) !== entry.hash) throw new Error(`备份校验失败：${entry.name}，没有恢复任何文件。`);
    }
    if (!names.has("weave.project.json")) throw new Error("备份缺少项目标识");
    const header = this.read(this.inside(backup.path, "weave.project.json"));
    if (header.schemaVersion !== 1) throw new Error("工程版本不受支持，原备份未修改");
    const staging = `${destination}.weave-restore-${this.uuid()}`;
    fs.mkdirSync(staging);
    try {
      for (const entry of manifest.files) {
        const file = this.inside(staging, entry.name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(this.inside(backup.path, entry.name), file, fs.constants.COPYFILE_EXCL);
        if (this.hashFile(file) !== entry.hash) throw new Error("恢复复制校验失败");
      }
      const project = { ...header, id: this.uuid(), originProjectId: header.id, name: `${header.name}（恢复）` };
      delete project.publicInbox;
      this.atomic(path.join(staging, "weave.project.json"), project);
      if (fs.existsSync(destination)) fs.rmdirSync(destination);
      fs.renameSync(staging, destination);
      this.repo.register(destination);
      this.markCurrent(destination);
      return this.repo.snapshot(project.id);
    } catch (error) {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true });
      throw error;
    }
  }
}
module.exports = { ProjectSafety };
