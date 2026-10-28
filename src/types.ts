export type AssetCategory =
  | "uncategorized"
  | "product"
  | "character"
  | "scene"
  | "prop"
  | "storyboard"
  | "script"
  | "video"
  | "audio"
  | "other";
export type AssetStatus = "candidate" | "final" | "rejected";
export type Asset = {
  id: string;
  name: string;
  relativePath: string;
  kind: "image" | "video" | "audio" | "document";
  category: AssetCategory;
  status: AssetStatus;
  size: number;
  mime: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  hash: string;
  source: string;
  prompt: string;
  tags: string[];
  shotId?: string;
  stackId?: string;
  stackOrder?: number;
  trashedAt?: string;
  url?: string;
  width?: number;
  height?: number;
  duration?: number;
};
export type Project = {
  id: string;
  name: string;
  root: string;
  createdAt: string;
  updatedAt?: string;
  assetCount?: number;
  paragraphCount?: number;
  schemaVersion: number;
  publicInbox?: boolean;
  unavailable?: boolean;
};
export type Shot = {
  id: string;
  title: string;
  description: string;
  dialogue: string;
  duration: number;
  prompt: string;
  status: "draft" | "image" | "video" | "review" | "done";
  revision: number;
  createdAt: string;
  updatedAt: string;
  order?: number;
  assetIds?: string[];
};
export type Activity = {
  id: string;
  actor: string;
  deviceId?: string;
  type: string;
  message: string;
  createdAt: string;
  assetIds?: string[];
  shotId?: string;
};
export type Settings = {
  deviceId?: string;
  displayName: string;
  inboxPath: string;
  receiveProjectId: string;
  receiveShotId: string;
  notifications: boolean;
  background: boolean;
  mutedProjects?: string[];
  lastSeen?: Record<string, string>;
  api?: {
    baseUrl: string;
    model: string;
    key?: string;
    hasKey?: boolean;
    enabled: boolean;
  };
};
export type ProjectSnapshot = {
  project: Project;
  assets: Asset[];
  shots: Shot[];
  activities: Activity[];
  editing?: EditDocument;
  editingHistory?: EditingVersion[];
  canvas?: CanvasDocument;
};
export type EditingVersion = { id: string; createdAt: string; label: string; actionType: string; paragraphId?: string; document: EditDocument };
export type CanvasNode = {
  id: string; kind: "asset" | "note"; assetId?: string; text?: string;
  x: number; y: number; width: number; height: number; frameId?: string; mediaRatio?: number;
};
export type CanvasFrame = {
  id: string; title: string; note: string; x: number; y: number;
  width: number; height: number; collapsed: boolean; locked: boolean;
};
export type CanvasDocument = {
  version: 1; id: string; revision: number; updatedAt: string;
  nodes: CanvasNode[]; frames: CanvasFrame[];
  viewport: { x: number; y: number; zoom: number };
};
export type EditLink = { assetId: string; role: "primary" | "alternate" };
export type EditNote = {
  id: string;
  text: string;
  quote: string;
  resolved: boolean;
  createdAt: string;
};
export type EditMark = { start: number; end: number };
export type EditParagraph = {
  id: string;
  text: string;
  generated: boolean;
  links: EditLink[];
  notes: EditNote[];
  marks: EditMark[];
  legacyShotId?: string;
};
export type EditDocument = {
  version: 1;
  id: string;
  revision: number;
  title: string;
  updatedAt: string;
  sources: { id: string; text: string; createdAt: string }[];
  paragraphs: EditParagraph[];
  removed: { paragraph: EditParagraph; index: number; removedAt: string }[];
};
export type EditAction = { type: string; [key: string]: unknown };
export type Bootstrap = {
  projects: Project[];
  activeProjectId?: string;
  snapshot?: ProjectSnapshot;
  settings: Settings;
  warning?: string;
  capabilities?: Record<string, boolean>;
};
export type ImportFile = {
  name: string;
  bytes?: number[];
  blob?: Blob;
  source?: string;
};
export type ExportInclude = {
  assets: boolean;
  originals: boolean;
  storyboard: boolean;
  scripts: boolean;
  videos: boolean;
};
export type DesktopBridge = {
  invoke: (method: string, payload?: Record<string, unknown>) => Promise<any>;
  startAssetDrag: (projectId: string, assetId: string) => void;
  onChanged: (callback: (event: any) => void) => () => void;
  droppedFilePath: (file: File) => string;
  checkForUpdates: () => Promise<any>;
  downloadUpdate: () => Promise<any>;
  openUpdate: (path: string) => Promise<{ ok: boolean }>;
  onUpdate: (callback: (status: any) => void) => () => void;
};
export const categories: { id: AssetCategory | "all"; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "uncategorized", label: "未分类" },
  { id: "product", label: "产品" },
  { id: "character", label: "角色" },
  { id: "scene", label: "场景" },
  { id: "storyboard", label: "分镜" },
  { id: "script", label: "脚本" },
  { id: "video", label: "视频" },
  { id: "audio", label: "音频" },
  { id: "other", label: "其他" },
];
/** Old classifications remain readable; empty legacy tabs are not destinations. */
export function libraryCategories(assets: Asset[]) {
  return categories.filter(c => !["storyboard", "script"].includes(c.id) ||
    assets.some(a => !a.trashedAt && matchesCategory(a, c.id)));
}
export function formatSize(bytes: number) {
  return bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
export function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function matchesCategory(asset: Asset, category: AssetCategory | "all") {
  return (
    category === "all" ||
    (category === "video"
      ? asset.kind === "video" || asset.category === category
      : category === "script"
        ? asset.kind === "document" || asset.category === category
        : category === "audio"
          ? asset.kind === "audio" || asset.category === category
          : category === "uncategorized" ? asset.category === "uncategorized" || asset.category === "prop" : asset.category === category)
  );
}
/** Explicit shot references are authoritative; shotId supports older projects. */
export function shotAssetIds(shot: Shot, assets: Asset[]): string[] {
  return (
    shot.assetIds ??
    assets.filter((asset) => asset.shotId === shot.id).map((asset) => asset.id)
  );
}
