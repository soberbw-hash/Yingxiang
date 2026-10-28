import {
  browserInvoke,
  browserProjectData,
  installBrowserProject,
  bufferBrowserChanges,
} from "./browserRepository.ts";
import {
  folderConnections,
  rememberFolder,
  ensureIndependentFolder,
  type FolderConnection,
} from "./folderConnections.ts";
import {
  directoryPermission,
  optionalJson,
  safePart,
  hashBlob,
  writeVerified,
  type DiskDirectory,
} from "./directoryFiles.ts";
import { loadFolderProject, saveFolderProject } from "./folderProjects.ts";
import { scanDirectory, type ScanState } from "./directoryScan.ts";

const writeMethods = new Set([
  "saveCanvas",
  "editAssetStack",
  "editReference",
  "importFiles",
  "updateAssets",
  "trashAssets",
  "restoreAssets",
  "createShot",
  "updateShot",
  "deleteShot",
  "transferAssets",
]);
let queue: Promise<unknown> = Promise.resolve();
let activeId = "";
const scans = new Map<string, ScanState>();

async function syncFolder(folder: FolderConnection) {
  const disk = await loadFolderProject(folder.handle);
  disk.record.project.root = `directory:${folder.id}`;
  const cached = await browserProjectData(folder.id);
  const state = scans.get(folder.id) || new Map();
  scans.set(folder.id, state);
  const scan = await scanDirectory(folder.handle, state, {
    exclude: new Set(Object.values(disk.paths)),
    knownHashes: new Set(disk.record.assets.map((asset) => asset.hash)),
  });
  let imported = 0;
  const warnings = [...scan.warnings];
  const changed = JSON.stringify(cached.record) !== JSON.stringify(disk.record);
  if (!scan.files.length) {
    if (changed) await installBrowserProject(disk.record, disk.media);
    return {
      changed,
      imported,
      pending: scan.pending,
      warnings,
      checkedAt: new Date().toISOString(),
    };
  }
  // Read-only grants still allow refreshing commits, but never cache-only imports.
  if (scan.files.length) await directoryPermission(folder.handle, true);
  await bufferBrowserChanges(async () => {
    await installBrowserProject(disk.record, disk.media);
    try {
      for (const file of scan.files) {
        try {
          const result = await browserInvoke("importFiles", {
            projectId: folder.id,
            category: file.category,
            files: [
              {
                name: file.name,
                blob: file.blob,
                source: `目录自动收录：${file.path}`,
              },
            ],
          });
          imported += result.imported;
        } catch (reason) {
          warnings.push(`「${file.path}」未收录：${(reason as Error).message}`);
        }
      }
      if (imported) {
        const next = await browserProjectData(folder.id);
        const saved = await saveFolderProject(
          folder.handle,
          next.record,
          next.media,
          disk.commitId,
          (await browserInvoke("bootstrap")).settings.deviceId,
        );
        warnings.push(...saved.cleanupWarnings);
      }
    } catch (reason) {
      await installBrowserProject(disk.record, disk.media);
      throw reason;
    }
  });
  return {
    changed: imported > 0 || changed,
    imported,
    pending: scan.pending,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}

async function copyDirectory(
  source: DiskDirectory,
  target: DiskDirectory,
  state = { count: 0 },
  depth = 0,
): Promise<void> {
  if (depth > 20) throw new Error("目录层级过深，未切换原项目位置");
  for await (const entry of source.values()) {
    if (++state.count > 20000)
      throw new Error("项目目录超过两万项，未切换原项目位置");
    if (entry.kind === "directory")
      await copyDirectory(
        entry,
        await target.getDirectoryHandle(entry.name, { create: true }),
        state,
        depth + 1,
      );
    else {
      const blob = await entry.getFile();
      await writeVerified(target, entry.name, blob, await hashBlob(blob));
    }
  }
}

async function relocateProject(
  handle: DiskDirectory,
  id: string,
  connection?: FolderConnection,
) {
  await directoryPermission(handle, true);
  await ensureIndependentFolder(handle, "local");
  if (
    connection?.handle.resolve &&
    (await connection.handle.resolve(handle)) !== null
  )
    throw new Error("新位置不能是原项目本身或它的子目录；请选择其他保存目录");
  const source = connection
    ? await loadFolderProject(connection.handle)
    : await browserProjectData(id);
  if (!connection && source.record.project.root.startsWith("directory:"))
    throw new Error(
      "原目录连接已失效，请先打开原项目目录；不能用缓存替代完整项目搬迁",
    );
  if (source.record.project.id !== id)
    throw new Error("项目身份不一致，未更改保存位置");
  const root = await handle.getDirectoryHandle(
    `${safePart(source.record.project.name)}__${crypto.randomUUID().slice(0, 8)}`,
    { create: true },
  );
  if (connection) {
    await copyDirectory(connection.handle, root);
    const check = await loadFolderProject(connection.handle);
    if (
      check.commitId !==
      (source as Awaited<ReturnType<typeof loadFolderProject>>).commitId
    )
      throw new Error("复制期间原项目有更新，未切换位置；原目录保留，请重试");
  } else {
    source.record.project.root = `directory:${id}`;
    await saveFolderProject(
      root,
      source.record,
      source.media,
      null,
      (await browserInvoke("bootstrap")).settings.deviceId,
    );
  }
  const verified = await loadFolderProject(root);
  if (verified.record.project.id !== id)
    throw new Error("副本校验失败，原连接保留");
  if (
    connection &&
    verified.commitId !==
      (source as Awaited<ReturnType<typeof loadFolderProject>>).commitId
  )
    throw new Error("复制期间目录内容有变化，未切换原位置，请重试");
  // Switch only after complete copy and validation. Keep the old folder untouched.
  await rememberFolder({
    key: `project:${id}`,
    id,
    kind: "project",
    handle: root,
    name: root.name,
  });
  verified.record.project.root = `directory:${id}`;
  await installBrowserProject(verified.record, verified.media);
  scans.delete(id);
  return { name: root.name };
}
export async function attachProjectFolder(
  handle: DiskDirectory,
  sourceId?: string,
) {
  await ensureIndependentFolder(handle, "local");
  await directoryPermission(handle, true, true);
  let root = handle;
  let loaded;
  if (sourceId) {
    const source = await browserProjectData(sourceId);
    const record = structuredClone(source.record);
    record.project.id = crypto.randomUUID();
    record.project.root = `directory:${record.project.id}`;
    delete record.project.publicInbox;
    delete record.publicInbox;
    root = await handle.getDirectoryHandle(
      `${safePart(record.project.name)}__${record.project.id.slice(0, 8)}`,
      { create: true },
    );
    const settings = (await browserInvoke("bootstrap")).settings;
    await saveFolderProject(
      root,
      record,
      source.media,
      null,
      settings.deviceId,
    );
    loaded = await loadFolderProject(root);
  } else {
    loaded = await loadFolderProject(root);
    try {
      const prior = await browserProjectData(loaded.record.project.id);
      if (!prior.record.project.root.startsWith("directory:"))
        throw new Error(
          "此目录与现有浏览器项目身份相同，请先另存独立副本；未覆盖现有工程",
        );
    } catch (error) {
      if (!(error as Error).message.startsWith("项目不存在")) throw error;
    }
  }
  const registered = (await folderConnections()).find(
    (item) => item.kind === "project" && item.id === loaded.record.project.id,
  );
  if (
    registered &&
    registered.handle.isSameEntry &&
    !(await registered.handle.isSameEntry(root))
  )
    throw new Error(
      "相同身份的项目已连接到另一个目录，请勿把副本当作原项目同时编辑；请先另存独立项目",
    );
  loaded.record.project.root = `directory:${loaded.record.project.id}`;
  await rememberFolder({
    key: `project:${loaded.record.project.id}`,
    handle: root,
    name: root.name,
    kind: "project",
    id: loaded.record.project.id,
  });
  await installBrowserProject(loaded.record, loaded.media);
  await browserInvoke("selectProject", { id: loaded.record.project.id });
}
export async function authorizeFolder(connection: FolderConnection) {
  await directoryPermission(connection.handle, true, true);
}

async function invokeFolder(method: string, payload: Record<string, unknown>) {
  const connections = await folderConnections();
  if (method === "createProject" && !payload.publicInbox) {
    const destination = connections.find(
      (item) => item.kind === "project-root",
    );
    if (destination) {
      await directoryPermission(destination.handle, true);
      return bufferBrowserChanges(async () => {
        const result = await browserInvoke(method, payload);
        const data = await browserProjectData(result.id);
        const handle = await destination.handle.getDirectoryHandle(
          `${safePart(data.record.project.name)}__${result.id.slice(0, 8)}`,
          { create: true },
        );
        data.record.project.root = `directory:${result.id}`;
        try {
          await saveFolderProject(
            handle,
            data.record,
            data.media,
            null,
            (await browserInvoke("bootstrap")).settings.deviceId,
          );
          await rememberFolder({
            key: `project:${result.id}`,
            kind: "project",
            id: result.id,
            name: handle.name,
            handle,
          });
          await installBrowserProject(data.record, data.media);
          activeId = result.id;
        } catch (error) {
          throw new Error(
            `目录保存失败，新项目草稿仍保留在浏览器：${(error as Error).message}`,
          );
        }
        return result;
      });
    }
  }
  const id = String(
    payload.projectId ||
      (method === "selectProject" ? payload.id : "") ||
      activeId ||
      "",
  );
  const folder = connections.find(
    (item) => item.kind === "project" && item.id === id,
  );
  if (method === "syncProjectFolder" || method === "relocateProjectFolder") {
    if (!id) throw new Error("请先选择项目");
    if (!folder && method === "syncProjectFolder") return { connected: false };
    if (!navigator.locks)
      throw new Error("浏览器缺少安全的目录写入锁，未自动收录或更改路径");
    return navigator.locks.request(`weave-folder:${id}`, () =>
      method === "syncProjectFolder"
        ? syncFolder(folder!)
        : relocateProject(payload.handle as DiskDirectory, id, folder),
    );
  }
  if (method === "bootstrap") {
    let result = await browserInvoke(method, payload);
    activeId = result.activeProjectId || "";
    const activeFolder = connections.find(
      (item) => item.kind === "project" && item.id === activeId,
    );
    if (activeFolder) {
      try {
        const disk = await loadFolderProject(activeFolder.handle);
        disk.record.project.root = `directory:${activeId}`;
        await installBrowserProject(disk.record, disk.media);
        result = await browserInvoke(method, payload);
      } catch (error) {
        result.warning = `目录暂不可确认，当前仅显示浏览器缓存，不能视为已保存：${(error as Error).message}`;
      }
    } else if (result.snapshot?.project.root.startsWith("directory:")) {
      result.warning =
        "当前是目录项目的浏览器缓存，目录连接已失效；请重新打开原目录，未改写磁盘或旧工程。";
    }
    result.projects = result.projects.map((project: { id: string }) => {
      const connected = connections.find(
        (item) => item.kind === "project" && item.id === project.id,
      );
      return connected
        ? { ...project, root: `本地文件夹 · ${connected.name}` }
        : project;
    });
    return result;
  }
  if (
    method === "transferAssets" &&
    (folder ||
      connections.some(
        (item) =>
          item.kind === "project" && item.id === payload.targetProjectId,
      ))
  ) {
    const targetId = String(payload.targetProjectId || "");
    if (!targetId || targetId === id) throw new Error("请选择另一个项目");
    if (!navigator.locks)
      throw new Error("浏览器缺少安全的目录写入锁，未转移素材");
    const targetFolder = connections.find(
      (item) => item.kind === "project" && item.id === targetId,
    );
    const work = () =>
      bufferBrowserChanges(async () => {
        const source = folder
          ? await loadFolderProject(folder.handle)
          : await browserProjectData(id);
        const target = targetFolder
          ? await loadFolderProject(targetFolder.handle)
          : await browserProjectData(targetId);
        if (folder) source.record.project.root = `directory:${id}`;
        if (targetFolder) target.record.project.root = `directory:${targetId}`;
        if (
          (!folder && source.record.project.root.startsWith("directory:")) ||
          (!targetFolder && target.record.project.root.startsWith("directory:"))
        )
          throw new Error("项目目录连接已失效，请重新授权后转移");
        await installBrowserProject(source.record, source.media);
        await installBrowserProject(target.record, target.media);
        let targetSaved = false;
        try {
          const result = await browserInvoke("transferAssets", payload);
          const nextTarget = await browserProjectData(targetId);
          const client = (await browserInvoke("bootstrap")).settings.deviceId;
          if (targetFolder)
            await saveFolderProject(
              targetFolder.handle,
              nextTarget.record,
              nextTarget.media,
              (target as Awaited<ReturnType<typeof loadFolderProject>>)
                .commitId,
              client,
            );
          targetSaved = true;
          if (folder && payload.move) {
            const nextSource = await browserProjectData(id);
            await saveFolderProject(
              folder.handle,
              nextSource.record,
              nextSource.media,
              (source as Awaited<ReturnType<typeof loadFolderProject>>)
                .commitId,
              client,
            );
          }
          return result;
        } catch (reason) {
          await installBrowserProject(source.record, source.media);
          if (!targetSaved)
            await installBrowserProject(target.record, target.media);
          throw new Error(
            `${targetSaved ? "目标项目已保存完整副本，源项目仍保留，未完成移动；" : "转移未完成，源项目保留；"}${(reason as Error).message}`,
          );
        }
      });
    const keys = [id, targetId].sort();
    return navigator.locks.request(`weave-folder:${keys[0]}`, () =>
      navigator.locks.request(`weave-folder:${keys[1]}`, work),
    );
  }
  if (!folder && writeMethods.has(method) && id) {
    const cached = await browserProjectData(id);
    if (cached.record.project.root.startsWith("directory:"))
      throw new Error(
        "目录连接已失效，请重新打开原项目文件夹；未把修改仅保存到浏览器缓存",
      );
  }
  if (method === "transferAssets" && payload.targetProjectId) {
    const target = await browserProjectData(String(payload.targetProjectId));
    if (target.record.project.root.startsWith("directory:"))
      throw new Error("目标是目录项目，请通过公共库复制，未修改任何项目");
  }
  if (
    !folder ||
    (!writeMethods.has(method) &&
      method !== "selectProject" &&
      method !== "exportBackup" &&
      method !== "exportProject")
  )
    return browserInvoke(method, payload);
  if (method === "transferAssets" && String(payload.targetProjectId) !== id)
    throw new Error(
      "目录项目暂不支持跨项目移动；请通过公共资产库复制，源素材不会删除",
    );
  const work = () =>
    bufferBrowserChanges(async () => {
      const disk = await loadFolderProject(folder.handle);
      disk.record.project.root = `directory:${id}`;
      await installBrowserProject(disk.record, disk.media);
      try {
        const result = await browserInvoke(method, payload);
        if (writeMethods.has(method)) {
          const next = await browserProjectData(id);
          const saved = await saveFolderProject(
            folder.handle,
            next.record,
            next.media,
            disk.commitId,
            (await browserInvoke("bootstrap")).settings.deviceId,
          );
          if (saved.cleanupWarnings.length)
            result.directoryWarning = saved.cleanupWarnings.join("；");
        }
        if (method === "selectProject") activeId = id;
        return result;
      } catch (error) {
        await installBrowserProject(disk.record, disk.media);
        throw error;
      }
    });
  if (navigator.locks)
    return navigator.locks.request(`weave-folder:${id}`, work);
  if (writeMethods.has(method))
    throw new Error(
      "浏览器缺少安全的目录写入锁，未保存；请使用公司允许的兼容浏览器",
    );
  return work();
}
export function folderBrowserInvoke(
  method: string,
  payload: Record<string, unknown> = {},
): Promise<any> {
  const task = queue.then(() => invokeFolder(method, payload));
  queue = task.catch(() => {});
  return task;
}
