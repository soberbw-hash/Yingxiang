import type { AssetCategory } from "../types";
import {
  directoryPermission,
  hashBlob,
  optionalJson,
  type DiskDirectory,
} from "./directoryFiles.ts";

const images = new Set(["png", "jpg", "jpeg", "webp", "avif", "gif", "bmp"]);
const media = new Set([
  ...images,
  "mp4",
  "mov",
  "webm",
  "mkv",
  "avi",
  "mp3",
  "wav",
  "m4a",
  "ogg",
  "flac",
  "txt",
  "md",
  "pdf",
  "doc",
  "docx",
  "json",
]);
const folders: Record<string, AssetCategory> = {
  角色: "character",
  场景: "scene",
  道具: "uncategorized",
  产品: "product",
  分镜: "storyboard",
  脚本: "script",
  视频: "video",
  音频: "audio",
  其他: "other",
};
type Observation = { stamp: string; since: number };
export type ScanState = Map<string, Observation>;
export type ScannedFile = {
  path: string;
  name: string;
  blob: Blob;
  hash: string;
  category: AssetCategory;
};

// Two observations avoid capturing downloads/copies that are still being written.
// This state is deliberately transient: after reopening, observe the source again.
export async function scanDirectory(
  root: DiskDirectory,
  state: ScanState,
  options: {
    imagesOnly?: boolean;
    exclude?: Set<string>;
    knownHashes?: Set<string>;
    now?: number;
  } = {},
) {
  await directoryPermission(root, false);
  const now = options.now ?? Date.now();
  const files: ScannedFile[] = [],
    warnings: string[] = [];
  const knownPaths: { path: string; hash: string }[] = [];
  const scannedFolders: string[] = [];
  const visited = new Set<string>();
  let count = 0,
    bytes = 0,
    pending = 0;
  const walk = async (
    directory: DiskDirectory,
    prefix: string,
    depth: number,
  ) => {
    if (depth > 12)
      throw new Error("目录层级超过 12 层，请选择更具体的素材目录");
    for await (const entry of directory.values()) {
      if (++count > 10000)
        throw new Error("目录超过一万项，请选择更具体的素材目录");
      if (
        entry.name.startsWith(".") ||
        ["_Weave", "node_modules", "备份", "导出"].includes(entry.name)
      )
        continue;
      const path = prefix + entry.name;
      if (entry.kind === "directory") {
        // Never consume another project's originals or a nested public library.
        if (
          (await optionalJson(entry, "weave.project-folder.json")) ||
          (await optionalJson(entry, "weave.library.json")) ||
          (await optionalJson(entry, "weave.project.json"))
        )
          continue;
        if (depth === 0) scannedFolders.push(entry.name);
        await walk(entry, path + "/", depth + 1);
        continue;
      }
      const ext = entry.name.split(".").pop()?.toLowerCase() || "";
      if (
        !(options.imagesOnly ? images : media).has(ext) ||
        /^weave\./i.test(entry.name)
      )
        continue;
      // Includes orphan media from interrupted commits; they are not user drops.
      if (
        options.exclude?.has(path) ||
        /__[a-f\d-]{36}(?:_r\d+)?\.[a-z\d]+$/i.test(entry.name)
      )
        continue;
      const blob = await entry.getFile();
      visited.add(path);
      if (!blob.size) {
        pending++;
        continue;
      }
      if (blob.size > 300 * 1024 * 1024) {
        warnings.push(`「${path}」超过自动收录的 300 MB 上限，请手动导入。`);
        continue;
      }
      const modified = (blob as File).lastModified || 0;
      const stamp = `${blob.size}:${modified}`;
      const prior = state.get(path);
      if (!prior || prior.stamp !== stamp) {
        state.set(path, { stamp, since: now });
        pending++;
        continue;
      }
      if (now - prior.since < 1500 || (modified && now - modified < 1500)) {
        pending++;
        continue;
      }
      const hash = await hashBlob(blob);
      if (options.knownHashes?.has(hash)) {
        knownPaths.push({ path, hash });
        continue;
      }
      if (files.length >= 100 || bytes + blob.size > 500 * 1024 * 1024) {
        pending++;
        continue;
      }
      // Check again after reading; a source copy may have resumed meanwhile.
      const check = await entry.getFile();
      if (
        check.size !== blob.size ||
        ((check as File).lastModified || 0) !== modified
      ) {
        state.delete(path);
        pending++;
        continue;
      }
      bytes += blob.size;
      const category =
        path
          .split("/")
          .slice(0, -1)
          .map((part) => folders[part])
          .find(Boolean) ||
        (images.has(ext)
          ? "uncategorized"
          : ["txt", "md", "pdf", "doc", "docx", "json"].includes(ext)
            ? "script"
            : ["mp4", "mov", "webm", "mkv", "avi"].includes(ext)
              ? "video"
              : ["mp3", "wav", "m4a", "ogg", "flac"].includes(ext)
                ? "audio"
                : "uncategorized");
      files.push({ path, name: entry.name, blob, hash, category });
    }
  };
  await walk(root, "", 0);
  for (const key of state.keys()) if (!visited.has(key)) state.delete(key);
  return { files, warnings, pending, knownPaths, folders: scannedFolders };
}
