import type { SharedAsset } from "./sharedLibrary";

const folderCategories: Record<string, string> = {
  未分类: "uncategorized", 产品: "product", 角色: "character", 场景: "scene",
  视频: "video", 音频: "audio", 其他: "other", 分镜: "storyboard", 道具: "uncategorized",
};

export function publicFolderCategory(name?: string) {
  return folderCategories[name?.trim() || ""];
}

export function publicAssetCategory(asset: Pick<SharedAsset, "group" | "sourceFolder">) {
  return publicFolderCategory(asset.sourceFolder) || (asset.group === "prop" ? "uncategorized" : asset.group);
}
