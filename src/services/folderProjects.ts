import type { Asset } from "../types";
import {
  validateRecord,
  type RecoveryRecord,
  type RecoveryMedia,
} from "./projectArchive.ts";
import {
  appendCommit,
  directoryPermission,
  hashBlob,
  optionalJson,
  readCommits,
  readDiskFile,
  readVersionFile,
  archivePreviousPath,
  safePart,
  writeDiskFile,
  writeVerified,
  pathParts,
  type DiskDirectory,
} from "./directoryFiles.ts";

export const categoryFolders: Record<string, string> = {
  uncategorized: "未分类",
  character: "角色",
  scene: "场景",
  prop: "道具",
  storyboard: "分镜",
  script: "脚本",
  video: "视频",
  audio: "音频",
  other: "其他",
  product: "产品",
};
export function readableAssetPath(
  asset: Pick<Asset, "id" | "name" | "category" | "trashedAt"> & {
    kind?: Asset["kind"];
  },
) {
  const dot = asset.name.lastIndexOf(".");
  const stem = safePart(dot > 0 ? asset.name.slice(0, dot) : asset.name);
  const ext = dot > 0 ? asset.name.slice(dot + 1).toLowerCase() : "bin";
  if (!/^[a-z0-9]{1,10}$/.test(ext) || !/^[a-f0-9-]{36}$/i.test(asset.id))
    throw new Error("素材名称或编号无效");
  return `${asset.trashedAt ? "_Weave/回收站" : asset.kind === "audio" && asset.category === "uncategorized" ? "音频" : categoryFolders[asset.category] || "未分类"}/${stem}__${asset.id}.${ext}`;
}
type FolderProject = {
  kind: "project";
  record: RecoveryRecord;
  paths: Record<string, string>;
};
export async function loadFolderProject(root: DiskDirectory) {
  await directoryPermission(root, false);
  const header = await optionalJson(root, "weave.project-folder.json");
  if (
    !header ||
    header.format !== "weave-project-folder" ||
    header.schemaVersion !== 1
  )
    throw new Error("不是兼容的映箱本地项目文件夹，未修改任何文件");
  const commits = await readCommits<FolderProject>(root);
  const referenced = new Set(
    commits.map((commit) => commit.parent).filter(Boolean),
  );
  const heads = commits.filter((commit) => !referenced.has(commit.id));
  if (heads.length !== 1)
    throw new Error(
      heads.length
        ? "项目存在同时编辑冲突，已保留双方提交并停止写入；请保留目录备份"
        : "项目还没有完整提交，请保留文件夹并重新保存",
    );
  const head = heads[0];
  if (head.data.kind !== "project") throw new Error("项目提交类型无效");
  const record = validateRecord(head.data.record);
  if (record.project.id !== header.id)
    throw new Error("项目身份与文件夹不一致");
  const media: RecoveryMedia[] = [];
  for (const asset of record.assets) {
    const path = head.data.paths[asset.id];
    pathParts(path || "");
    const blob = await readVersionFile(root, path, asset);
    if (blob.size !== asset.size || (await hashBlob(blob)) !== asset.hash)
      throw new Error(
        `文件已改名、移动或校验不符：${asset.name}。未用浏览器缓存覆盖目录，请保留原目录并核对文件。`,
      );
    media.push({
      id: asset.id,
      hash: asset.hash,
      blob: blob.slice(0, blob.size, asset.mime),
    });
  }
  return { record, media, commitId: head.id, paths: head.data.paths };
}
export async function saveFolderProject(
  root: DiskDirectory,
  raw: RecoveryRecord,
  media: RecoveryMedia[],
  base: string | null,
  clientId: string,
) {
  await directoryPermission(root, true);
  const record = validateRecord(raw);
  const header = await optionalJson(root, "weave.project-folder.json");
  if (
    header &&
    (header.format !== "weave-project-folder" ||
      header.schemaVersion !== 1 ||
      header.id !== record.project.id)
  )
    throw new Error("目录属于另一个项目或更高版本，未覆盖");
  const existing = await readCommits<FolderProject>(root);
  const parents = new Set(existing.map((commit) => commit.parent));
  const heads = existing.filter((commit) => !parents.has(commit.id));
  if (
    (base === null && existing.length) ||
    (base !== null && (heads.length !== 1 || heads[0].id !== base))
  )
    throw new Error("目录项目已被另一窗口修改，请重新打开后再保存");
  const paths: Record<string, string> = {};
  const mediaMap = new Map(media.map((item) => [item.id, item]));
  for (const asset of record.assets) {
    const item = mediaMap.get(asset.id);
    if (!item || item.hash !== asset.hash)
      throw new Error(`缺少原片：${asset.name}`);
    paths[asset.id] = readableAssetPath(asset);
    await writeVerified(root, paths[asset.id], item.blob, asset.hash);
  }
  if (!header)
    await writeDiskFile(
      root,
      "weave.project-folder.json",
      JSON.stringify(
        {
          format: "weave-project-folder",
          schemaVersion: 1,
          id: record.project.id,
          name: record.project.name,
        },
        null,
        2,
      ),
      true,
    );
  // Recheck after copying media. A stale writer must not silently become the head.
  const recheck = await readCommits<FolderProject>(root);
  if (recheck.length !== existing.length)
    throw new Error("复制期间项目发生变化，已保留原文件，请重新打开后重试");
  const commit = await appendCommit<FolderProject>(
    root,
    { kind: "project", record, paths },
    base,
    clientId,
  );
  const check = await readCommits<FolderProject>(root);
  const used = new Set(check.map((item) => item.parent));
  if (check.filter((item) => !used.has(item.id)).length !== 1)
    throw new Error(
      "检测到同时保存冲突，双方提交均已保留，请停止编辑并保留目录备份",
    );
  const cleanupWarnings: string[] = [];
  const previous = heads[0]?.data;
  if (previous)
    for (const asset of record.assets) {
      const oldPath = previous.paths[asset.id];
      if (oldPath && oldPath !== paths[asset.id]) {
        try {
          await archivePreviousPath(root, oldPath, paths[asset.id], asset);
        } catch {
          cleanupWarnings.push(
            `「${asset.name}」新位置已保存，旧位置未完成归档；原片仍保留。`,
          );
        }
      }
    }
  return { commitId: commit.id, cleanupWarnings };
}
