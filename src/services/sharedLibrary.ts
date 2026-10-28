import type { Asset, AssetCategory } from "../types";
import {
  appendCommit,
  directoryPermission,
  hashBlob,
  isMissing,
  optionalJson,
  pathParts,
  readCommits,
  readDiskFile,
  readVersionFile,
  archivePreviousPath,
  safePart,
  writeDiskFile,
  writeVerified,
  type DiskCommit,
  type DiskDirectory,
} from "./directoryFiles.ts";
import { categoryFolders } from "./folderProjects.ts";
import { scanDirectory, type ScanState } from "./directoryScan.ts";

export const libraryGroups = [
  { id: "product", label: "产品" },
  { id: "character", label: "角色" },
  { id: "scene", label: "场景" },
  { id: "prop", label: "道具" },
  { id: "storyboard", label: "分镜" },
  { id: "other", label: "其他" },
  { id: "uncategorized", label: "未分类" },
] as const;
export type LibraryGroup = (typeof libraryGroups)[number]["id"];
export type SharedAsset = Asset & {
  group: LibraryGroup;
  libraryId: string;
  head: string;
  external?: boolean;
  origin?: { libraryId?: string; assetId: string; hash: string };
  conflict?: boolean;
  sourceFolder?: string;
};
type Entry = Omit<SharedAsset, "url" | "head" | "conflict">;
type LibraryChange = {
  kind: "library";
  action: "add" | "edit" | "trash" | "restore";
  entries: Entry[];
  resolves?: string[];
};
export type LibraryUpdate = {
  id: string;
  createdAt: string;
  clientId: string;
  category: LibraryGroup;
  count: number;
  assetIds: string[];
};
export type LibrarySnapshot = {
  id: string;
  assets: SharedAsset[];
  updates: LibraryUpdate[];
  warnings: string[];
  folders?: string[];
};
const imageExtensions = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "avif",
  "gif",
  "bmp",
]);
const idPattern = /^[a-f0-9-]{36}$/i;
function validateEntry(entry: Entry, libraryId: string) {
  if (
    !entry ||
    !idPattern.test(entry.id) ||
    entry.libraryId !== libraryId ||
    entry.kind !== "image" ||
    typeof entry.name !== "string" ||
    typeof entry.relativePath !== "string" ||
    !/^[a-f0-9]{64}$/i.test(entry.hash) ||
    !Number.isInteger(entry.revision) ||
    entry.revision < 1 ||
    !libraryGroups.some((group) => group.id === entry.group) ||
    !Number.isFinite(entry.size) ||
    entry.size < 0
  )
    throw new Error("公共库记录无效，未修改共享文件");
  if (
    entry.category !== (entry.group === "product" ? "prop" : entry.group) ||
    typeof entry.createdAt !== "string" ||
    typeof entry.updatedAt !== "string" ||
    typeof entry.mime !== "string" ||
    typeof entry.prompt !== "string" ||
    !Array.isArray(entry.tags)
  )
    throw new Error("公共库素材属性不完整，未修改共享文件");
  pathParts(entry.relativePath);
}
export async function initializeLibrary(root: DiskDirectory) {
  await directoryPermission(root, true);
  if (await optionalJson(root, "weave.project-folder.json"))
    throw new Error("这是个人项目文件夹，请选择单独的公共库文件夹，避免公开项目素材。");
  const existing = await optionalJson(root, "weave.library.json");
  if (existing) {
    if (
      existing.format !== "weave-shared-library" ||
      existing.schemaVersion !== 1 ||
      !idPattern.test(existing.id)
    )
      throw new Error("公共库格式不受支持，原目录未修改");
    return existing.id as string;
  }
  let hasInstructions = false;
  try {
    await readDiskFile(root, "_Weave/目录说明.txt");
    hasInstructions = true;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const id = crypto.randomUUID();
  await writeDiskFile(
    root,
    "weave.library.json",
    JSON.stringify(
      {
        format: "weave-shared-library",
        schemaVersion: 1,
        id,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    true,
  );
  if (!hasInstructions) await writeDiskFile(
    root,
    "_Weave/目录说明.txt",
    "公共资产按产品、角色、场景等中文目录保存。_Weave 保存校验提交与历史文件，不要手动删除。软件不包含账号，也不会上传到外部服务器。请通过 Weave 整理受管理素材；共享盘自身仍需要备份。",
    true,
  );
  return id;
}

// Each publication has its own immutable commit. No shared mutable master JSON.
export async function librarySnapshot(
  root: DiskDirectory,
): Promise<LibrarySnapshot> {
  await directoryPermission(root, false);
  const header = await optionalJson(root, "weave.library.json");
  if (
    !header ||
    header.format !== "weave-shared-library" ||
    header.schemaVersion !== 1 ||
    !idPattern.test(header.id)
  )
    throw new Error("这不是可识别的 Weave 公共库，请重新选择共享文件夹");
  const commits = await readCommits<LibraryChange>(root);
  const versions = new Map<
    string,
    { entry: Entry; commit: DiskCommit<LibraryChange> }[]
  >();
  const updates: LibraryUpdate[] = [];
  for (const commit of commits) {
    if (
      commit.data.kind !== "library" ||
      !["add", "edit", "trash", "restore"].includes(commit.data.action) ||
      !Array.isArray(commit.data.entries) ||
      commit.data.entries.length > 1000
    )
      throw new Error("公共库提交格式无效");
    if (
      commit.data.resolves !== undefined &&
      (!Array.isArray(commit.data.resolves) ||
        commit.data.resolves.length > 1000 ||
        commit.data.resolves.some(
          (id) => typeof id !== "string" || !idPattern.test(id),
        ))
    )
      throw new Error("公共库冲突合并记录无效");
    const groups = new Map<LibraryGroup, string[]>();
    for (const entry of commit.data.entries) {
      validateEntry(entry, header.id);
      const list = versions.get(entry.id) || [];
      list.push({ entry, commit });
      versions.set(entry.id, list);
      if (commit.data.action === "add")
        groups.set(entry.group, [...(groups.get(entry.group) || []), entry.id]);
    }
    for (const [category, assetIds] of groups)
      updates.push({
        id: `${commit.id}:${category}`,
        createdAt: commit.createdAt,
        clientId: commit.clientId,
        category,
        count: assetIds.length,
        assetIds,
      });
  }
  const assets: SharedAsset[] = [];
  const warnings: string[] = [];
  for (const [id, list] of versions) {
    const referenced = new Set(
      list
        .flatMap((version) => [
          version.commit.parent,
          ...(version.commit.data.resolves || []),
        ])
        .filter(Boolean),
    );
    const heads = list.filter((version) => !referenced.has(version.commit.id));
    // Show an explicit conflicted entry, never choose and overwrite a branch.
    const conflicted = heads.length !== 1;
    const selected = [...heads].sort((a, b) =>
      a.commit.id.localeCompare(b.commit.id),
    )[0];
    if (!selected) throw new Error(`公共库版本链无效：${id}`);
    if (conflicted)
      warnings.push(
        `「${selected.entry.name}」有同时修改冲突，已保留双方版本；选中素材后可「解决冲突」。`,
      );
    assets.push({
      ...selected.entry,
      head: selected.commit.id,
      conflict: conflicted,
    });
  }
  const hashes = new Set<string>();
  const unique = assets
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((asset) => {
      if (asset.trashedAt || asset.conflict) return true;
      const key = asset.hash;
      // Independent offline/network writers can race after the preflight check.
      // Keep both manageable rather than hiding one that would reappear after trashing the other.
      if (hashes.has(key))
        warnings.push(
          `「${asset.name}」与另一张图片内容相同，可能来自同时收录；可分别整理或移入回收站。`,
        );
      hashes.add(key);
      return true;
    });
  const visibleIds = new Set(unique.map((asset) => asset.id));
  const visibleUpdates = updates
    .map((update) => {
      const assetIds = update.assetIds.filter((id) => visibleIds.has(id));
      return { ...update, assetIds, count: assetIds.length };
    })
    .filter((update) => update.count > 0);
  return {
    id: header.id,
    assets: unique,
    updates: visibleUpdates.sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ),
    warnings,
  };
}
export async function sharedConflictVersions(
  root: DiskDirectory,
  assetId: string,
) {
  const commits = (await readCommits<LibraryChange>(root)).filter(
    (commit) =>
      commit.data.kind === "library" &&
      commit.data.entries.some((entry) => entry.id === assetId),
  );
  const used = new Set(
    commits
      .flatMap((commit) => [commit.parent, ...(commit.data.resolves || [])])
      .filter(Boolean),
  );
  return commits
    .filter((commit) => !used.has(commit.id))
    .map((commit) => ({
      head: commit.id,
      entry: commit.data.entries.find((entry) => entry.id === assetId)!,
    }));
}
export async function resolveSharedConflict(
  root: DiskDirectory,
  clientId: string,
  assetId: string,
  selectedHead: string,
  observedHeads: string[],
) {
  await directoryPermission(root, true);
  const versions = await sharedConflictVersions(root, assetId);
  if (
    versions.length < 2 ||
    versions
      .map((version) => version.head)
      .sort()
      .join() !== [...observedHeads].sort().join()
  )
    throw new Error("冲突版本已有变化，请重新查看后选择；未覆盖新修改");
  const chosen = versions.find((version) => version.head === selectedHead);
  if (!chosen) throw new Error("请选择保留的版本");
  const blob = await sharedAssetBlob(root, {
    ...chosen.entry,
    head: chosen.head,
  });
  const next: Entry = {
    ...chosen.entry,
    revision:
      Math.max(...versions.map((version) => version.entry.revision)) + 1,
    updatedAt: new Date().toISOString(),
  };
  next.relativePath = publicPath(next);
  await writeVerified(root, next.relativePath, blob, next.hash);
  const recheck = await sharedConflictVersions(root, assetId);
  if (
    recheck
      .map((version) => version.head)
      .sort()
      .join() !== [...observedHeads].sort().join()
  )
    throw new Error("选择期间又有更新，请刷新冲突列表；原版本均保留");
  await appendCommit<LibraryChange>(
    root,
    {
      kind: "library",
      action: "edit",
      entries: [next],
      resolves: observedHeads,
    },
    selectedHead,
    clientId,
  );
  const saved = (await librarySnapshot(root)).assets.find(
    (asset) => asset.id === assetId,
  );
  if (!saved || saved.conflict)
    throw new Error("合并期间又发生修改，所有版本已保留；请刷新后重新处理冲突");
  return next;
}
export async function imageLibraryInput(
  file: File,
): Promise<{ asset: Asset; blob: Blob }> {
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  const detected = bytes[0] === 137 && text.slice(1, 4) === "PNG" ? "png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpg"
    : text.startsWith("RIFF") && text.slice(8, 12) === "WEBP" ? "webp"
    : /^GIF8[79]a/.test(text) ? "gif"
    : text.startsWith("BM") ? "bmp"
    : text.slice(4, 8) === "ftyp" && /avif|avis/.test(text) ? "avif"
    : undefined;
  if (!detected || !imageExtensions.has(ext)) throw new Error(`不是兼容的图片原文件：${file.name}`);
  const actualExt = detected === "jpg" && ext === "jpeg" ? "jpeg" : detected;
  const name = actualExt === ext ? file.name : `${file.name.slice(0, file.name.lastIndexOf("."))}.${actualExt}`;
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  return {
    blob: file,
    asset: {
      id,
      name,
      relativePath: `media/${id}.${actualExt}`,
      kind: "image",
      category: "uncategorized",
      mime: `image/${actualExt === "jpg" ? "jpeg" : actualExt}`,
      size: file.size,
      hash: await hashBlob(file),
      revision: 1,
      createdAt: now,
      updatedAt: now,
      source: "文件导入",
      prompt: "",
      tags: [],
      status: "candidate",
    },
  };
}
export async function sharedAssetBlob(root: DiskDirectory, asset: SharedAsset) {
  const blob = await readVersionFile(root, asset.relativePath, asset);
  if (blob.size !== asset.size || (await hashBlob(blob)) !== asset.hash)
    throw new Error(
      `公共库原片已被外部修改或移动：${asset.name}；未复制错误文件`,
    );
  return blob.slice(0, blob.size, asset.mime);
}
function publicPath(asset: Entry) {
  const dot = asset.name.lastIndexOf(".");
  const ext = asset.name.slice(dot + 1).toLowerCase();
  if (!imageExtensions.has(ext))
    throw new Error("公共库目前只接收 PNG/JPG/WebP/AVIF/GIF/BMP 图片");
  const folder = asset.trashedAt
    ? "_Weave/回收站"
    : categoryFolders[asset.group];
  return `${folder}/${safePart(asset.name.slice(0, dot))}__${asset.id}_r${asset.revision}.${ext}`;
}
export async function publishToLibrary(
  root: DiskDirectory,
  clientId: string,
  inputs: { asset: Asset; blob: Blob; sourceFolder?: string }[],
  group?: LibraryGroup,
) {
  if (inputs.length > 1000)
    throw new Error("一次最多收录 1000 张图片，请分批操作");
  await directoryPermission(root, true);
  const snapshot = await librarySnapshot(root);
  const hashes = new Set(
    snapshot.assets
      .filter((asset) => !asset.trashedAt)
      .map((asset) => asset.hash),
  );
  const entries: Entry[] = [];
  let duplicates = 0;
  for (const input of inputs) {
    if (input.asset.kind !== "image")
      throw new Error("公共资产库仅收录图片；视频继续保存在项目中");
    const hash = await hashBlob(input.blob);
    if (hash !== input.asset.hash || input.blob.size !== input.asset.size)
      throw new Error(`源文件校验失败：${input.asset.name}`);
    if (hashes.has(hash)) {
      duplicates++;
      continue;
    }
    hashes.add(hash);
    const category =
      group ||
      (libraryGroups.some((item) => item.id === input.asset.category)
        ? (input.asset.category as LibraryGroup)
        : "uncategorized");
    const now = new Date().toISOString();
    const entry: Entry = {
      id: crypto.randomUUID(),
      libraryId: snapshot.id,
      name: input.asset.name,
      relativePath: "",
      group: category,
      category: category === "product" ? "prop" : category,
      kind: "image",
      mime: input.asset.mime,
      size: input.blob.size,
      hash,
      status: "final",
      revision: 1,
      source: "公共资产库",
      prompt: "",
      tags: [],
      createdAt: now,
      updatedAt: now,
      origin: { assetId: input.asset.id, hash },
      ...(input.sourceFolder ? { sourceFolder: input.sourceFolder } : {}),
    };
    entry.relativePath = publicPath(entry);
    await writeVerified(root, entry.relativePath, input.blob, hash);
    entries.push(entry);
  }
  if (entries.length)
    await appendCommit<LibraryChange>(
      root,
      { kind: "library", action: "add", entries },
      null,
      clientId,
    );
  return { added: entries.length, duplicates };
}
export async function editSharedAsset(
  root: DiskDirectory,
  clientId: string,
  asset: SharedAsset,
  patch: { name?: string; group?: LibraryGroup; trashedAt?: string | null },
) {
  await directoryPermission(root, true);
  const current = (await librarySnapshot(root)).assets.find(
    (entry) => entry.id === asset.id,
  );
  if (!current || current.conflict || current.head !== asset.head)
    throw new Error("公共素材已被其他窗口修改，请刷新后重试；未覆盖对方版本");
  if (asset.external) throw new Error("关联目录是只读的，未修改现有文件");
  const blob = await sharedAssetBlob(root, current);
  const { head: _head, url: _url, conflict: _conflict, ...entry } = current;
  const next: Entry = {
    ...entry,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (
      name.slice(name.lastIndexOf(".")).toLowerCase() !==
      current.name.slice(current.name.lastIndexOf(".")).toLowerCase()
    )
      throw new Error("重命名请保留原扩展名；修改扩展名不会转换图片格式");
    next.name = name;
  }
  if (patch.group !== undefined) {
    next.group = patch.group;
    delete next.sourceFolder;
  }
  if (patch.trashedAt === null) delete next.trashedAt;
  else if (patch.trashedAt !== undefined) next.trashedAt = patch.trashedAt;
  next.category = next.group === "product" ? "prop" : next.group;
  next.relativePath = publicPath(next);
  validateEntry(next, current.libraryId);
  await writeVerified(root, next.relativePath, blob, next.hash);
  const observed = (await librarySnapshot(root)).assets.find(
    (entry) => entry.id === asset.id,
  );
  if (!observed || observed.conflict || observed.head !== current.head)
    throw new Error("保存期间公共素材有更新，已保留原片，请刷新重试");
  await appendCommit<LibraryChange>(
    root,
    {
      kind: "library",
      action:
        patch.trashedAt === null
          ? "restore"
          : patch.trashedAt
            ? "trash"
            : "edit",
      entries: [next],
    },
    current.head,
    clientId,
  );
  const after = (await librarySnapshot(root)).assets.find(
    (entry) => entry.id === asset.id,
  );
  if (after?.conflict)
    throw new Error(
      "发生同时整理冲突，双方版本和原片已保留；请刷新查看，未自动覆盖任何一方",
    );
  let cleanupWarning = "";
  if (
    after?.head !== current.head &&
    next.relativePath !== current.relativePath
  ) {
    try {
      await archivePreviousPath(
        root,
        current.relativePath,
        next.relativePath,
        current,
      );
    } catch {
      cleanupWarning =
        "新分类已保存，旧文件未完成归档；原片仍保留，请保留目录并核对。";
    }
  }
  return { entry: next, cleanupWarning };
}

export async function scanExternalLibrary(
  root: DiskDirectory,
  libraryId: string,
): Promise<LibrarySnapshot> {
  await directoryPermission(root, false);
  const assets: SharedAsset[] = [];
  const folders: string[] = [];
  let seen = 0;
  const walk = async (
    directory: DiskDirectory,
    prefix: string,
    depth: number,
  ) => {
    if (depth > 12) throw new Error("目录层级过深，请关联更具体的素材目录");
    for await (const entry of directory.values()) {
      if (++seen > 10000)
        throw new Error("目录超过一万项，请关联更具体的公共素材目录");
      if (entry.name.startsWith(".") || entry.name === "_Weave") continue;
      const path = prefix + entry.name;
      if (entry.kind === "directory") {
        if (depth === 0) folders.push(entry.name);
        await walk(entry, path + "/", depth + 1);
        continue;
      }
      const ext = entry.name.split(".").pop()?.toLowerCase() || "";
      if (!imageExtensions.has(ext)) continue;
      const blob = await entry.getFile();
      const hash = await hashBlob(blob);
      const group =
        libraryGroups.find((item) => path.split("/").includes(item.label))
          ?.id || "uncategorized";
      const id = await hashBlob(new Blob([path]));
      assets.push({
        id,
        libraryId,
        head: hash,
        external: true,
        sourceFolder: path.includes("/") ? path.split("/")[0] : undefined,
        relativePath: path,
        group,
        category: group === "product" ? "prop" : group,
        name: entry.name,
        kind: "image",
        mime: blob.type || `image/${ext === "jpg" ? "jpeg" : ext}`,
        size: blob.size,
        hash,
        createdAt: new Date((blob as File).lastModified || 0).toISOString(),
        updatedAt: "",
        revision: 1,
        source: "只读关联目录",
        prompt: "",
        tags: [],
        status: "candidate",
      });
    }
  };
  await walk(root, "", 0);
  return {
    id: libraryId,
    assets,
    updates: assets.map((asset) => ({
      id: `external:${asset.id}:${asset.hash}`,
      createdAt: asset.createdAt,
      clientId: "external-directory",
      category: asset.group,
      count: 1,
      assetIds: [asset.id],
    })),
    warnings: [],
    folders,
  };
}

// Unmanaged source files remain in place. Content changes are collected as new
// assets, not destructive revisions of an asset referenced by a private project.
export async function syncLibraryDirectory(
  root: DiskDirectory,
  state: ScanState,
  now?: number,
  clientId = "external-directory",
) {
  const snapshot = await librarySnapshot(root);
  for (const asset of snapshot.assets.filter(
    (asset) => !asset.trashedAt && !asset.conflict,
  )) {
    try {
      await sharedAssetBlob(root, asset);
    } catch {
      snapshot.warnings.push(
        `「${asset.name}」受管理原片不可访问或已被外部修改；未覆盖历史记录，请还原原片。`,
      );
    }
  }
  const history = await readCommits<LibraryChange>(root);
  const knownHashes = new Set(
    history.flatMap((commit) => commit.data.entries.map((entry) => entry.hash)),
  );
  const scan = await scanDirectory(root, state, {
    imagesOnly: true,
    exclude: new Set(snapshot.assets.map((asset) => asset.relativePath)),
    knownHashes,
    now,
  });
  let added = 0;
  for (const file of scan.files) {
    try {
      const input = await imageLibraryInput(new File([file.blob], file.name));
      const group = file.path.split("/").includes("产品")
        ? "product"
        : file.category;
      const result = await publishToLibrary(
        root,
        clientId,
        [{ ...input, sourceFolder: file.path.includes("/") ? file.path.split("/")[0] : undefined }],
        libraryGroups.some((item) => item.id === group)
          ? (group as LibraryGroup)
          : "uncategorized",
      );
      added += result.added;
    } catch (reason) {
      scan.warnings.push(
        `「${file.path}」未收录：${(reason as Error).message}`,
      );
    }
  }
  const next = added ? await librarySnapshot(root) : snapshot;
  const sourceFolders = new Map<string, Set<string>>();
  for (const file of [...scan.knownPaths, ...scan.files]) {
    const folder = file.path.includes("/") ? file.path.split("/")[0] : "";
    if (!folder) continue;
    const folders = sourceFolders.get(file.hash) || new Set<string>();
    folders.add(folder);
    sourceFolders.set(file.hash, folders);
  }
  for (const asset of next.assets) {
    const folders = sourceFolders.get(asset.hash);
    if (!asset.sourceFolder && asset.revision === 1 && folders?.size === 1)
      asset.sourceFolder = [...folders][0];
  }
  if (added)
    next.warnings.push(
      ...snapshot.warnings.filter(
        (warning) => !next.warnings.includes(warning),
      ),
    );
  next.warnings.push(...scan.warnings);
  next.folders = scan.folders;
  return { snapshot: next, added, pending: scan.pending };
}
