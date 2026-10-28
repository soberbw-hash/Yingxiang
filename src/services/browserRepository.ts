import type {
  Activity,
  Asset,
  AssetCategory,
  Bootstrap,
  ProjectSnapshot,
  Settings,
  Shot,
  EditAction,
} from "../types";
import { createZip, type ZipEntry } from "./zip.ts";
import { shotAssetIds } from "../types.ts";
import {
  applyStackEdit,
  syncStackLinks,
  validateAssetStacks,
  expandStackIds,
  type StackAction,
} from "../../shared/asset-stacks.mjs";
import {
  applyEditing,
  editingForExport,
  validateEditing,
} from "../../shared/editing.mjs";
import { saveCanvas, validateCanvas, canvasForExport } from "../../shared/canvas.mjs";
import { rememberEditingVersion } from "../../shared/editing-history.mjs";
import { backupWithoutTrash, buildBackup, parseProjectArchive } from "./projectArchive.ts";

const DB_NAME = "weave-browser";
const DB_VERSION = 1;
export function namedExportPaths(assets: Asset[]) {
  const used = new Set<string>();
  return assets.map((asset) => {
    const storedExt = asset.relativePath.split(".").pop() || "bin";
    const namedExt = asset.name.match(/\.([a-z0-9]{1,12})$/i)?.[1] || storedExt;
    const rawBase = asset.name.replace(/\.[^.\\/]+$/, "");
    let base = Array.from(rawBase.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim()).slice(0, 120).join("").replace(/[. ]+$/g, "") || "素材";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
    let filename = `${base}.${namedExt}`;
    let suffix = 1;
    while (used.has(filename.toLocaleLowerCase())) {
      filename = `${base}_${asset.id.slice(0, 8)}${suffix > 1 ? `_${suffix}` : ""}.${namedExt}`;
      suffix++;
    }
    used.add(filename.toLocaleLowerCase());
    return { ...asset, relativePath: `media/${filename}` };
  });
}
export type ProjectRecord = ProjectSnapshot & {
  publicInbox?: boolean;
  trashShots?: Record<string, string>;
  trashShotReferences?: Record<string, string[]>;
};
type Meta = {
  key: "state";
  activeProjectId?: string;
  settings: Settings;
  deviceId: string;
};
type StoredBlob = { projectId: string; id: string; hash: string; blob: Blob };
const defaults = (): Settings => ({
  displayName: "我",
  inboxPath: "",
  receiveProjectId: "",
  receiveShotId: "",
  notifications: true,
  background: false,
  lastSeen: {},
});
const listeners = new Set<(event: any) => void>();
const objectUrls = new Map<string, { hash: string; blob: Blob; url: string }>();
let database: Promise<IDBDatabase> | undefined;
let channel: BroadcastChannel | undefined;
let channelUnavailable = false;

function changed(event: Record<string, unknown>, broadcast = true) {
  if (bufferedEvents) {
    bufferedEvents.push({ event, broadcast });
    return;
  }
  for (const callback of listeners) {
    try {
      callback(event);
    } catch (error) {
      console.error("Weave change listener failed", error);
    }
  }
  if (broadcast) {
    try {
      getChannel()?.postMessage(event);
    } catch {
      /* Committed data remains available through bootstrap. */
    }
  }
}
let bufferedEvents:
  | { event: Record<string, unknown>; broadcast: boolean }[]
  | undefined;
export async function bufferBrowserChanges<T>(
  work: () => Promise<T>,
): Promise<T> {
  if (bufferedEvents) throw new Error("另一个目录操作尚未完成，请稍后重试");
  bufferedEvents = [];
  try {
    const result = await work();
    const events = bufferedEvents;
    bufferedEvents = undefined;
    for (const item of events) changed(item.event, item.broadcast);
    return result;
  } finally {
    bufferedEvents = undefined;
  }
}

// Disk projects use this store only as a rebuildable working cache. No old DB reset.
export async function browserProjectData(id: string) {
  return transaction("readonly", async (tx) => {
    const record = await project(tx, id);
    const media = await Promise.all(
      record.assets.map(async (asset) => {
        const stored = await request<StoredBlob | undefined>(
          tx.objectStore("blobs").get([id, asset.id]),
        );
        if (!stored || stored.hash !== asset.hash)
          throw new Error(`原片缺失：${asset.name}`);
        return { id: asset.id, hash: stored.hash, blob: stored.blob };
      }),
    );
    return { record, media };
  });
}
export async function installBrowserProject(
  record: ProjectRecord,
  media: { id: string; hash: string; blob: Blob }[],
  createOnly = false,
) {
  await transaction("readwrite", async (tx) => {
    if (createOnly) tx.objectStore("projects").add(record);
    else tx.objectStore("projects").put(record);
    for (const item of media)
      tx.objectStore("blobs").put({ ...item, projectId: record.project.id });
    return undefined;
  });
}
function getChannel() {
  if (
    !channel &&
    !channelUnavailable &&
    typeof BroadcastChannel !== "undefined"
  ) {
    try {
      channel = new BroadcastChannel("weave-browser-changes-v1");
      channel.onmessage = (event) => changed(event.data, false);
    } catch {
      // Some local-file origins disallow cross-tab channels, while still
      // allowing IndexedDB. This optional notification path must not block it.
      channelUnavailable = true;
    }
  }
  return channel;
}
export function browserOnChanged(callback: (event: any) => void): () => void {
  getChannel();
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
function clearUrls() {
  for (const entry of objectUrls.values()) URL.revokeObjectURL(entry.url);
  objectUrls.clear();
}
if (typeof window !== "undefined")
  window.addEventListener("pagehide", clearUrls);

function openDatabase(): Promise<IDBDatabase> {
  if (!database)
    database = new Promise<IDBDatabase>((resolve, reject) => {
      if (!globalThis.crypto?.subtle || !globalThis.crypto?.randomUUID) {
        reject(
          new Error(
            "当前地址缺少安全浏览器环境，请让 IT 提供获批的 HTTPS 内网地址，或允许的本地 HTML 打开方式；无需关闭浏览器安全防护。",
          ),
        );
        return;
      }
      if (typeof indexedDB === "undefined") {
        reject(new Error("浏览器不支持持久存储，请使用桌面端或启用 IndexedDB"));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        // Version 1 migration; originals are separate from portable project metadata.
        if (!db.objectStoreNames.contains("projects"))
          db.createObjectStore("projects", { keyPath: "project.id" });
        if (!db.objectStoreNames.contains("blobs"))
          db.createObjectStore("blobs", { keyPath: ["projectId", "id"] });
        if (!db.objectStoreNames.contains("meta"))
          db.createObjectStore("meta", { keyPath: "key" });
      };
      request.onerror = () =>
        reject(
          new Error(
            `无法打开浏览器持久存储：${request.error?.message || "请检查隐私与存储设置"}。若公司策略限制本地 HTML，请联系 IT 提供获批的 HTTPS 内网地址。`,
          ),
        );
      request.onblocked = () =>
        reject(
          new Error(
            "项目存储升级被其他标签页阻止，请关闭其他映箱标签页后重试",
          ),
        );
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          database = undefined;
          clearUrls();
        };
        resolve(db);
      };
    }).catch((error) => {
      database = undefined;
      throw error;
    });
  return database;
}
function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openDatabase();
  const tx = db.transaction(["projects", "blobs", "meta"], mode);
  const completed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error || new Error("项目操作已取消，未保存任何修改"));
    tx.onerror = () => {
      /* onabort reports failure; never announce a partial commit. */
    };
  });
  try {
    const result = await work(tx);
    await completed;
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Already aborted. */
    }
    await completed.catch(() => {});
    throw error;
  }
}
async function meta(tx: IDBTransaction): Promise<Meta> {
  const stored = await request<Meta | undefined>(
    tx.objectStore("meta").get("state"),
  );
  const result = stored || {
    key: "state",
    settings: defaults(),
    deviceId: crypto.randomUUID(),
  };
  result.settings = { ...defaults(), ...result.settings };
  if (result.settings.api) {
    const { key: _secret, ...api } = result.settings.api;
    result.settings.api = { ...api, hasKey: false };
  }
  if (!stored && tx.mode === "readwrite") tx.objectStore("meta").put(result);
  return result;
}
function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()))
    throw new Error(`${label}无效`);
  return value;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label}无效`);
  return value as Record<string, unknown>;
}
function fileName(value: unknown): string {
  const name = string(value, "文件名").trim();
  if (
    /[\\/:*?"<>|\x00-\x1f]/.test(name) ||
    name === "." ||
    name === ".." ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    throw new Error("请使用不含路径或特殊字符的文件名");
  return name;
}
function byteArray(value: unknown): Uint8Array {
  if (
    !Array.isArray(value) ||
    value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  )
    throw new Error("文件内容必须是 0–255 的字节数组");
  return Uint8Array.from(value);
}
const mediaTypes: Record<string, [Asset["kind"], string]> = {
  png: ["image", "image/png"],
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  webp: ["image", "image/webp"],
  gif: ["image", "image/gif"],
  bmp: ["image", "image/bmp"],
  avif: ["image", "image/avif"],
  mp4: ["video", "video/mp4"],
  mov: ["video", "video/quicktime"],
  webm: ["video", "video/webm"],
  mkv: ["video", "video/x-matroska"],
  avi: ["video", "video/x-msvideo"],
  mp3: ["audio", "audio/mpeg"],
  wav: ["audio", "audio/wav"],
  m4a: ["audio", "audio/mp4"],
  ogg: ["audio", "audio/ogg"],
  flac: ["audio", "audio/flac"],
  txt: ["document", "text/plain"],
  md: ["document", "text/markdown"],
  json: ["document", "application/json"],
  pdf: ["document", "application/pdf"],
  doc: ["document", "application/msword"],
  docx: [
    "document",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
};
function identify(name: string, bytes: Uint8Array) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const info = mediaTypes[ext];
  if (!info)
    throw new Error(
      `不支持的素材格式：${name}。请导入 PNG/JPEG/WebP/GIF/BMP、视频或 TXT/MD/PDF/Word 文档`,
    );
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.slice(start, end));
  let valid = false;
  switch (ext) {
    case "mp3":
      valid =
        ascii(0, 3) === "ID3" || (bytes[0] === 255 && (bytes[1] & 224) === 224);
      break;
    case "wav":
      valid = ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
      break;
    case "m4a":
      valid = ascii(4, 8) === "ftyp";
      break;
    case "ogg":
      valid = ascii(0, 4) === "OggS";
      break;
    case "flac":
      valid = ascii(0, 4) === "fLaC";
      break;
    case "png":
      valid = starts(137, 80, 78, 71, 13, 10, 26, 10);
      break;
    case "jpg":
    case "jpeg":
      valid = starts(255, 216, 255);
      break;
    case "gif":
      valid = ["GIF87a", "GIF89a"].includes(ascii(0, 6));
      break;
    case "bmp":
      valid = ascii(0, 2) === "BM";
      break;
    case "webp":
      valid = ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
      break;
    case "avif":
      valid =
        ascii(4, 8) === "ftyp" &&
        /avif|avis/.test(ascii(8, Math.min(bytes.length, 64)));
      break;
    case "avi":
      valid = ascii(0, 4) === "RIFF" && ascii(8, 12) === "AVI ";
      break;
    case "mp4":
    case "mov":
      valid =
        bytes.length >= 12 &&
        (ascii(4, 8) === "ftyp" ||
          (ext === "mov" && ["moov", "mdat", "wide"].includes(ascii(4, 8))));
      break;
    case "webm":
    case "mkv":
      valid = starts(26, 69, 223, 163);
      break;
    case "pdf":
      valid = ascii(0, 5) === "%PDF-";
      break;
    case "doc":
      valid = starts(208, 207, 17, 224, 161, 177, 26, 225);
      break;
    case "docx":
      valid = starts(80, 75, 3, 4);
      break;
    case "txt":
    case "md":
    case "json":
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        valid = !bytes.includes(0);
        if (ext === "json") JSON.parse(text);
      } catch {
        valid = false;
      }
  }
  if (!valid)
    throw new Error(`文件内容与扩展名不匹配或文本不是 UTF-8：${name}`);
  return { kind: info[0], mime: info[1] };
}
const categories = new Set<AssetCategory>([
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
]);
function assetPatch(value: unknown): Partial<Asset> {
  const patch = object(value, "素材修改");
  const allowed = new Set([
    "name",
    "category",
    "status",
    "source",
    "prompt",
    "tags",
    "shotId",
    "width",
    "height",
    "duration",
  ]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new Error(`不允许修改素材字段：${key}`);
    if (key === "name") fileName(patch[key]);
    if (["source", "prompt"].includes(key)) string(patch[key], key, true);
    if (key === "shotId" && patch[key] != null)
      string(patch[key], "镜头", true);
    if (key === "category" && !categories.has(patch[key] as AssetCategory))
      throw new Error("素材分类无效");
    if (
      key === "status" &&
      !["candidate", "final", "rejected"].includes(String(patch[key]))
    )
      throw new Error("素材状态无效");
    if (
      key === "tags" &&
      (!Array.isArray(patch[key]) ||
        (patch[key] as unknown[]).some((tag) => typeof tag !== "string"))
    )
      throw new Error("标签必须是文字数组");
    if (
      ["width", "height", "duration"].includes(key) &&
      (typeof patch[key] !== "number" ||
        !Number.isFinite(patch[key]) ||
        (patch[key] as number) < 0 ||
        (key !== "duration" && !Number.isInteger(patch[key])))
    )
      throw new Error(
        `${key}必须是有效的非负${key === "duration" ? "数" : "整数"}`,
      );
  }
  return patch as Partial<Asset>;
}
function shotPatch(value: unknown): Partial<Shot> {
  const patch = object(value, "镜头修改");
  for (const key of Object.keys(patch)) {
    if (
      ![
        "title",
        "description",
        "dialogue",
        "duration",
        "prompt",
        "status",
        "order",
        "assetIds",
      ].includes(key)
    )
      throw new Error(`不允许修改镜头字段：${key}`);
    if (
      key === "assetIds" &&
      (!Array.isArray(patch[key]) ||
        (patch[key] as unknown[]).some((id) => typeof id !== "string"))
    )
      throw new Error("镜头素材关联必须是 ID 数组");
    if (["title", "description", "dialogue", "prompt"].includes(key))
      string(patch[key], key, key !== "title");
    if (
      ["duration", "order"].includes(key) &&
      (typeof patch[key] !== "number" ||
        !Number.isFinite(patch[key]) ||
        (patch[key] as number) < 0)
    )
      throw new Error(`${key}必须是非负数`);
    if (
      key === "status" &&
      !["draft", "image", "video", "review", "done"].includes(
        String(patch[key]),
      )
    )
      throw new Error("镜头状态无效");
  }
  return patch as Partial<Shot>;
}
function ids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((id) => typeof id !== "string" || !id)
  )
    throw new Error("请选择素材");
  return [...new Set(value)] as string[];
}
function revision(entity: Asset | Shot, expected: unknown) {
  if (!Number.isInteger(expected) || expected !== entity.revision)
    throw new Error(
      `版本冲突：${"name" in entity ? entity.name : entity.title} 已更新，请刷新后重试（当前版本 ${entity.revision}）`,
    );
}
async function project(
  tx: IDBTransaction,
  value: unknown,
): Promise<ProjectRecord> {
  const id = string(value, "项目 ID");
  const record = await request<ProjectRecord | undefined>(
    tx.objectStore("projects").get(id),
  );
  if (!record) throw new Error("项目不存在，请重新选择项目");
  if (record.project.schemaVersion !== 1)
    throw new Error("项目版本不受支持，请使用更新的桌面端打开");
  return record;
}
function activity(
  record: ProjectRecord,
  state: Meta,
  type: string,
  message: string,
  extra: Partial<Activity> = {},
) {
  record.activities.push({
    id: crypto.randomUUID(),
    actor: state.settings.displayName || "我",
    deviceId: state.deviceId,
    type,
    message,
    createdAt: new Date().toISOString(),
    ...extra,
  });
}
async function mutateProject<T>(
  payload: Record<string, unknown>,
  type: string,
  work: (record: ProjectRecord, state: Meta, tx: IDBTransaction) => T,
  hasChanges: (result: T) => boolean = () => true,
) {
  const result = await transaction("readwrite", async (tx) => {
    const [record, state] = await Promise.all([
      project(tx, payload.projectId),
      meta(tx),
    ]);
    const result = work(record, state, tx);
    if (hasChanges(result)) {
      tx.objectStore("projects").put(record);
      tx.objectStore("meta").put(state);
    }
    return result;
  });
  if (hasChanges(result)) changed({ type, projectId: payload.projectId });
  return result;
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
async function bootstrap(): Promise<Bootstrap> {
  // First bootstrap initializes a stable device identity even before any project exists.
  const loaded = await transaction("readwrite", async (tx) => {
    const [records, state] = await Promise.all([
      request<ProjectRecord[]>(tx.objectStore("projects").getAll()),
      meta(tx),
    ]);
    const current = records.find(
      (record) => record.project.id === state.activeProjectId,
    );
    const blobs = current
      ? await Promise.all(
          current.assets.map((asset) =>
            request<StoredBlob | undefined>(
              tx.objectStore("blobs").get([current.project.id, asset.id]),
            ),
          ),
        )
      : [];
    return { records, state, current, blobs };
  });
  const { records, state, current, blobs } = loaded;
  if (current) validateAssetStacks(current.assets);
  if (current?.editing) validateEditing(current.editing, current.assets);
  if (current?.canvas) validateCanvas(current.canvas, current.assets);
  const keep = new Set<string>();
  const snapshot: ProjectSnapshot | undefined = current && {
    project: { ...current.project, publicInbox: current.publicInbox },
    shots: current.shots,
    activities: current.activities,
    editing: current.editing,
    editingHistory: current.editingHistory,
    canvas: current.canvas,
    assets: current.assets.map((asset, index) => {
      const stored = blobs[index];
      const key = `${current.project.id}/${asset.id}`;
      if (!stored || stored.hash !== asset.hash)
        throw new Error(
          `素材原文件缺失或存储不一致：${asset.name}，请重新导入或使用备份`,
        );
      keep.add(key);
      let cached = objectUrls.get(key);
      if (!cached || cached.hash !== stored.hash) {
        if (cached) URL.revokeObjectURL(cached.url);
        cached = {
          hash: stored.hash,
          blob: stored.blob,
          url: URL.createObjectURL(stored.blob),
        };
        objectUrls.set(key, cached);
      }
      const { url: _previous, ...portable } = asset;
      return { ...portable, url: cached.url };
    }),
  };
  for (const [key, cached] of objectUrls)
    if (!keep.has(key)) {
      URL.revokeObjectURL(cached.url);
      objectUrls.delete(key);
    }
  const settings = { ...state.settings, deviceId: state.deviceId };
  return {
    projects: records.map((record) => ({
      ...record.project,
      publicInbox: record.publicInbox,
      assetCount: record.assets.filter(asset => !asset.trashedAt).length,
      paragraphCount: record.editing?.paragraphs?.length ?? 0,
      updatedAt: (() => {
        const timestamps = [record.project.createdAt, record.editing?.updatedAt, record.canvas?.updatedAt, ...record.assets.map(asset => asset.updatedAt), ...record.shots.map(shot => shot.updatedAt), ...record.activities.map(event => event.createdAt)]
          .filter((value): value is string => typeof value === "string")
          .sort();
        return timestamps[timestamps.length - 1];
      })(),
    })),
    activeProjectId: current?.project.id,
    snapshot,
    settings,
    capabilities: {
      desktop: false,
      portableProjects: true,
      revisions: true,
      trash: true,
      folderImport: false,
      exportZip: true,
      exportFolder: false,
      ai: false,
      encryptedKey: false,
      sqliteCache: false,
      createProject: true,
      importFiles: true,
      openProject: false,
      sharedDrive: false,
      chooseInbox: false,
      watchInbox: false,
    },
  };
}

export async function browserInvoke(
  method: string,
  payload: Record<string, unknown> = {},
): Promise<any> {
  getChannel();
  switch (method) {
    case "bootstrap":
      return bootstrap();
    case "openProject":
      throw new Error("共享盘项目请在桌面端打开");
    case "chooseInbox":
      throw new Error(
        "自动接收文件夹需要桌面端，请在桌面端选择收件箱；浏览器可拖入或粘贴文件",
      );
    case "createProject": {
      const name = string(payload.name, "项目名称").trim();
      const id = crypto.randomUUID();
      const result = await transaction("readwrite", async (tx) => {
        const state = await meta(tx);
        if (payload.publicInbox === true) {
          const records = await request<ProjectRecord[]>(
            tx.objectStore("projects").getAll(),
          );
          const existing = records.find((record) => record.publicInbox);
          if (existing) {
            state.activeProjectId = existing.project.id;
            tx.objectStore("meta").put(state);
            return existing.project;
          }
        }
        const record: ProjectRecord = {
          project: {
            id,
            name,
            root: `indexeddb://${id}`,
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
          },
          assets: [],
          shots: [],
          activities: [],
          publicInbox: payload.publicInbox === true,
        };
        activity(record, state, "project.created", `创建项目「${name}」`);
        state.activeProjectId = id;
        if (payload.publicInbox === true) {
          state.settings.receiveProjectId = id;
          state.settings.receiveShotId = "";
        }
        tx.objectStore("projects").add(record);
        tx.objectStore("meta").put(state);
        return record.project;
      });
      changed({ type: "project.created", projectId: result.id });
      return result;
    }
    case "selectProject": {
      await transaction("readwrite", async (tx) => {
        const [record, state] = await Promise.all([
          project(tx, payload.projectId ?? payload.id),
          meta(tx),
        ]);
        state.activeProjectId = record.project.id;
        tx.objectStore("meta").put(state);
      });
      changed({
        type: "project.selected",
        projectId: payload.projectId ?? payload.id,
      });
      return { ok: true };
    }
    case "editAssetStack": {
      return mutateProject(payload, "assets.stacked", (record, state) => {
        const result = applyStackEdit(
          record.assets,
          payload.action as StackAction,
          object(payload.revisions, "素材版本"),
        );
        record.assets = result.assets;
        record.editing = syncStackLinks(record.editing, record.assets);
        if (record.editing) validateEditing(record.editing, record.assets);
        activity(record, state, "assets.stacked", "更新视频版本组", {
          assetIds: result.changedIds,
        });
        return { ok: true };
      });
    }
    case "saveCanvas": {
      return mutateProject(payload, "canvas.updated", (record) => {
        record.canvas = saveCanvas(record.canvas, payload.canvas, record.assets, payload.revision as number);
        return record.canvas;
      });
    }
    case "importFiles": {
      if (!Array.isArray(payload.files) || !payload.files.length)
        throw new Error("请拖入、粘贴或选择实际文件；浏览器无法读取本地路径");
      const category =
        payload.category === undefined
          ? "uncategorized"
          : (payload.category as AssetCategory);
      if (!categories.has(category)) throw new Error("素材分类无效");
      const shotId =
        payload.shotId == null
          ? undefined
          : string(payload.shotId, "镜头", true) || undefined;
      const prepared: {
        name: string;
        kind: Asset["kind"];
        mime: string;
        hash: string;
        blob: Blob;
        source: string;
      }[] = [];
      // Process one binary buffer at a time; keep Blobs, rather than expanded JS
      // number arrays, while waiting for the atomic IndexedDB write.
      for (const input of payload.files) {
        const file = object(input, "导入文件");
        const name = fileName(file.name);
        if (file.blob !== undefined && !(file.blob instanceof Blob))
          throw new Error("文件 blob 必须是 Blob");
        const inputBlob = file.blob as Blob | undefined;
        const bytes = inputBlob
          ? new Uint8Array(await inputBlob.arrayBuffer())
          : byteArray(file.bytes);
        const info = identify(name, bytes);
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer)),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        prepared.push({
          name,
          ...info,
          hash,
          blob: inputBlob
            ? inputBlob.slice(0, inputBlob.size, info.mime)
            : new Blob([bytes], { type: info.mime }),
          source:
            file.source === undefined
              ? "浏览器导入"
              : string(file.source, "素材来源", true),
        });
      }
      return mutateProject(
        payload,
        "assets.imported",
        (record, state, tx) => {
          const stackTarget = payload.stackTargetId
            ? record.assets.find(
                (asset) =>
                  asset.id === payload.stackTargetId &&
                  !asset.trashedAt &&
                  asset.kind === "video",
              )
            : undefined;
          if (
            payload.stackTargetId &&
            (!stackTarget || prepared.some((file) => file.kind !== "video"))
          )
            throw new Error(
              "请将视频拖到当前项目的视频卡片上；混合文件不会自动堆叠",
            );
          if (shotId && !record.shots.some((shot) => shot.id === shotId))
            throw new Error("目标镜头不存在");
          const hashes = new Set(record.assets.map((asset) => asset.hash));
          const duplicates: {
            name: string;
            id?: string;
            trashed: boolean;
            message: string;
          }[] = [];
          const accepted = [];
          for (const file of prepared) {
            if (hashes.has(file.hash)) {
              const existing = record.assets.find(
                (asset) => asset.hash === file.hash,
              );
              duplicates.push({
                name: file.name,
                id: existing?.id,
                trashed: Boolean(existing?.trashedAt),
                message: existing?.trashedAt
                  ? "已在回收站，可恢复原素材"
                  : "内容已存在，已跳过重复素材",
              });
              continue;
            }
            hashes.add(file.hash);
            accepted.push(file);
          }
          const imported = accepted.map((file) => {
            const id = crypto.randomUUID();
            const now = new Date().toISOString();
            const asset: Asset = {
              id,
              name: file.name,
              relativePath: `media/${id}.${file.name.split(".").pop()!.toLowerCase()}`,
              kind: file.kind,
              category:
                category === "uncategorized" && file.kind === "audio"
                  ? "audio"
                  : category,
              status: "candidate",
              size: file.blob.size,
              mime: file.mime,
              createdAt: now,
              updatedAt: now,
              revision: 1,
              hash: file.hash,
              source: file.source,
              prompt: "",
              tags: [],
              ...(shotId ? { shotId } : {}),
            };
            record.assets.push(asset);
            tx.objectStore("blobs").add({
              projectId: record.project.id,
              id,
              hash: file.hash,
              blob: file.blob,
            } satisfies StoredBlob);
            return asset;
          });
          let stackChanged = false;
          if (stackTarget) {
            const candidates = [
              ...imported.map((asset) => asset.id),
              ...duplicates
                .filter((file) => !file.trashed && file.id)
                .map((file) => file.id!),
            ];
            if (
              expandStackIds([stackTarget.id, ...candidates], record.assets)
                .length > 1
            ) {
              const stacked = applyStackEdit(
                record.assets,
                { type: "merge", id: stackTarget.id, assetIds: candidates },
                payload.revisions as Record<string, unknown>,
                imported.map((asset) => asset.id),
              );
              record.assets = stacked.assets;
              record.editing = syncStackLinks(record.editing, record.assets);
              if (record.editing)
                validateEditing(record.editing, record.assets);
              stackChanged = true;
            }
          }
          let linkedCount = 0;
          const shot = record.shots.find((item) => item.id === shotId);
          if (shot) {
            const previous = shotAssetIds(
              shot,
              record.assets.filter((asset) => !imported.includes(asset)),
            );
            const next = [
              ...new Set([
                ...previous,
                ...imported.map((asset) => asset.id),
                ...duplicates
                  .filter((file) => !file.trashed && file.id)
                  .map((file) => file.id!),
              ]),
            ];
            linkedCount = next.length - previous.length;
            if (linkedCount) {
              shot.assetIds = next;
              shot.revision++;
              shot.updatedAt = new Date().toISOString();
            }
          }
          if (imported.length)
            activity(
              record,
              state,
              "assets.imported",
              `导入 ${imported.length} 个素材`,
              { assetIds: imported.map((asset) => asset.id) },
            );
          else if (linkedCount && shot)
            activity(
              record,
              state,
              "shot.updated",
              `为「${shot.title}」关联 ${linkedCount} 个已有素材`,
              { shotId: shot.id, assetIds: shot.assetIds },
            );
          const trashedDuplicateCount = duplicates.filter(
            (file) => file.trashed,
          ).length;
          return {
            assets: imported,
            imported: imported.length,
            stackChanged,
            linkedCount,
            duplicateCount: duplicates.length,
            duplicates,
            trashedDuplicateCount,
            message: `导入 ${imported.length} 个素材${duplicates.length ? `，跳过 ${duplicates.length} 个重复素材` : ""}${trashedDuplicateCount ? `；其中 ${trashedDuplicateCount} 个已在回收站，可恢复原素材` : ""}`,
          };
        },
        (result) =>
          result.imported > 0 || result.linkedCount > 0 || result.stackChanged,
      );
    }
    case "updateAssets":
    case "trashAssets":
    case "restoreAssets": {
      const selected = ids(payload.ids);
      const revisions = object(payload.revisions, "素材版本");
      const patch = method === "updateAssets" ? assetPatch(payload.patch) : {};
      return mutateProject(payload, method, (record, state) => {
        const targets = selected.map((id) => {
          const asset = record.assets.find((asset) => asset.id === id);
          if (!asset) throw new Error("素材不存在，请刷新后重试");
          revision(asset, revisions[id]);
          if (method !== "restoreAssets" && asset.trashedAt)
            throw new Error("素材已在回收站，请先恢复");
          if (method === "restoreAssets" && !asset.trashedAt)
            throw new Error("素材不在回收站");
          if (
            patch.name !== undefined &&
            patch.name.slice(patch.name.lastIndexOf(".")).toLowerCase() !==
              asset.name.slice(asset.name.lastIndexOf(".")).toLowerCase()
          )
            throw new Error("重命名请保留原扩展名；修改扩展名不会转换文件格式");
          return asset;
        });
        if (
          patch.shotId &&
          !record.shots.some((shot) => shot.id === patch.shotId)
        )
          throw new Error("目标镜头不存在");
        const now = new Date().toISOString();
        const priorFinals = record.assets
          .filter((asset) => !asset.trashedAt && asset.status === "final")
          .map((asset) => asset.id);
        for (const asset of targets) {
          if (method === "trashAssets") {
            if (asset.shotId)
              (record.trashShots ??= {})[asset.id] = asset.shotId;
            asset.trashedAt = now;
            delete asset.shotId;
            (record.trashShotReferences ??= {})[asset.id] = record.shots
              .filter((shot) => shot.assetIds?.includes(asset.id))
              .map((shot) => shot.id);
            for (const shot of record.shots)
              if (shot.assetIds?.includes(asset.id)) {
                shot.assetIds = shot.assetIds.filter((id) => id !== asset.id);
                shot.revision++;
                shot.updatedAt = now;
              }
          } else if (method === "restoreAssets") {
            delete asset.trashedAt;
            const previousShot = record.trashShots?.[asset.id];
            if (
              previousShot &&
              record.shots.some((shot) => shot.id === previousShot)
            )
              asset.shotId = previousShot;
            if (record.trashShots) delete record.trashShots[asset.id];
            for (const shot of record.shots)
              if (record.trashShotReferences?.[asset.id]?.includes(shot.id)) {
                shot.assetIds = [
                  ...new Set([...shotAssetIds(shot, record.assets), asset.id]),
                ];
                shot.revision++;
                shot.updatedAt = now;
              }
            if (record.trashShotReferences)
              delete record.trashShotReferences[asset.id];
          } else {
            Object.assign(asset, patch);
            if (patch.shotId === "" || patch.shotId === null)
              delete asset.shotId;
          }
          asset.updatedAt = now;
          asset.revision++;
        }
        // A final is exclusive within its stack, including a restored old final.
        const finalGroups = new Map<string, Asset[]>();
        for (const asset of record.assets)
          if (asset.stackId && !asset.trashedAt && asset.status === "final")
            finalGroups.set(asset.stackId, [
              ...(finalGroups.get(asset.stackId) || []),
              asset,
            ]);
        for (const group of finalGroups.values())
          if (group.length > 1) {
            const preferred =
              method === "restoreAssets" ? priorFinals : selected;
            const winner =
              group.find((asset) => preferred.includes(asset.id)) || group[0];
            for (const asset of group)
              if (asset.id !== winner.id) {
                if (!selected.includes(asset.id))
                  revision(asset, revisions[asset.id]);
                asset.status = "candidate";
                asset.revision++;
                asset.updatedAt = now;
              }
          }
        validateAssetStacks(record.assets);
        activity(
          record,
          state,
          method,
          `${method === "trashAssets" ? "移至回收站" : method === "restoreAssets" ? "恢复" : "更新"} ${targets.length} 个素材`,
          { assetIds: selected },
        );
        return { ok: true };
      });
    }
    case "transferAssets": {
      const selected = ids(payload.ids);
      const revisions = object(
        payload.revisions,
        "转移素材版本（请刷新后重试）",
      );
      const expected = Object.fromEntries(
        selected.map((id) => {
          const value = revisions[id];
          if (
            !Object.prototype.hasOwnProperty.call(revisions, id) ||
            !Number.isInteger(value) ||
            (value as number) < 1
          )
            throw new Error("转移素材版本缺失或无效，请刷新后重试");
          return [id, value];
        }),
      );
      const sourceId = string(payload.projectId, "源项目 ID");
      const targetId = string(payload.targetProjectId, "目标项目 ID");
      if (sourceId === targetId) throw new Error("请选择另一个目标项目");
      if (typeof payload.move !== "boolean")
        throw new Error("请选择复制或移动");
      const result = await transaction("readwrite", async (tx) => {
        const [source, target, state] = await Promise.all([
          project(tx, sourceId),
          project(tx, targetId),
          meta(tx),
        ]);
        const originals = selected.map((id) => {
          const asset = source.assets.find((asset) => asset.id === id);
          if (!asset || asset.trashedAt)
            throw new Error("源素材不存在或已在回收站，请刷新后重试");
          revision(asset, expected[id]);
          return asset;
        });
        const hashes = new Set(target.assets.map((asset) => asset.hash));
        for (const asset of originals) {
          if (hashes.has(asset.hash))
            throw new Error(
              `目标项目已有重复素材：${asset.name}（包括回收站）；本次转移未保存`,
            );
          hashes.add(asset.hash);
        }
        const blobs = await Promise.all(
          originals.map((asset) =>
            request<StoredBlob | undefined>(
              tx.objectStore("blobs").get([sourceId, asset.id]),
            ),
          ),
        );
        const now = new Date().toISOString();
        const copiedStacks = new Map<string,string>();
        const copied = originals.map((asset, index) => {
          const stored = blobs[index];
          if (!stored || stored.hash !== asset.hash)
            throw new Error(`源素材原文件缺失：${asset.name}；本次转移未保存`);
          const {
            shotId: _shot,
            trashedAt: _trashed,
            url: _url,
            ...portable
          } = asset;
          const id = crypto.randomUUID();
          if(asset.stackId&&!copiedStacks.has(asset.stackId))copiedStacks.set(asset.stackId,crypto.randomUUID());
          const extension = asset.relativePath.split(".").pop()!;
          const copy: Asset = {
            ...portable,
            ...(asset.stackId?{stackId:copiedStacks.get(asset.stackId)}:{}),
            id,
            relativePath: `media/${id}.${extension}`,
            tags: [...asset.tags],
            revision: 1,
            createdAt: asset.stackId ? asset.createdAt : now,
            updatedAt: now,
          };
          target.assets.push(copy);
          tx.objectStore("blobs").add({
            projectId: targetId,
            id,
            hash: asset.hash,
            blob: stored.blob,
          } satisfies StoredBlob);
          if (payload.move) {
            if (asset.shotId)
              (source.trashShots ??= {})[asset.id] = asset.shotId;
            delete asset.shotId;
            (source.trashShotReferences ??= {})[asset.id] = source.shots
              .filter((shot) => shot.assetIds?.includes(asset.id))
              .map((shot) => shot.id);
            for (const shot of source.shots)
              if (shot.assetIds?.includes(asset.id)) {
                shot.assetIds = shot.assetIds.filter((id) => id !== asset.id);
                shot.revision++;
                shot.updatedAt = now;
              }
            asset.trashedAt = now;
            asset.updatedAt = now;
            asset.revision++;
          }
          return copy;
        });
        const verb = payload.move ? "移动" : "复制";
        const type = payload.move ? "assets.moved" : "assets.copied";
        activity(
          source,
          state,
          type,
          `${verb} ${originals.length} 个素材至「${target.project.name}」`,
          { assetIds: selected },
        );
        activity(
          target,
          state,
          type,
          `从「${source.project.name}」${verb} ${copied.length} 个素材`,
          { assetIds: copied.map((asset) => asset.id) },
        );
        tx.objectStore("projects").put(source);
        tx.objectStore("projects").put(target);
        tx.objectStore("meta").put(state);
        return {
          ok: true,
          copied: copied.length,
          moved: payload.move ? copied.length : 0,
          assets: copied,
        };
      });
      changed({
        type: "assets.transferred",
        projectId: sourceId,
        targetProjectId: targetId,
      });
      return result;
    }
    case "editReference": {
      return mutateProject(payload, "editing.updated", (record, state) => {
        const history = rememberEditingVersion(record.editingHistory, record.editing, payload.action as EditAction);
        record.editing = applyEditing(
          record.editing,
          payload.action as any,
          record.assets,
          record.shots,
          payload.revision as number,
        );
        record.editingHistory = history;
        activity(record, state, "editing.updated", "更新剪辑文稿");
        return { revision: record.editing?.revision || 0 };
      });
    }
    case "createShot": {
      const patch = shotPatch(
        payload.patch ??
          Object.fromEntries(
            [
              "title",
              "description",
              "dialogue",
              "duration",
              "prompt",
              "status",
              "order",
            ]
              .filter((key) => payload[key] !== undefined)
              .map((key) => [key, payload[key]]),
          ),
      );
      return mutateProject(payload, "shot.created", (record, state) => {
        const now = new Date().toISOString();
        const order =
          record.shots.reduce(
            (max, shot, index) => Math.max(max, shot.order ?? index),
            -1,
          ) + 1;
        const shot: Shot = {
          id: crypto.randomUUID(),
          title: `镜头 ${record.shots.length + 1}`,
          description: "",
          dialogue: "",
          duration: 3,
          prompt: "",
          status: "draft",
          ...patch,
          order,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        record.shots.push(shot);
        activity(record, state, "shot.created", `创建「${shot.title}」`, {
          shotId: shot.id,
        });
        return shot;
      });
    }
    case "updateShot":
    case "deleteShot": {
      const id = string(payload.id ?? payload.shotId, "镜头 ID");
      const expected =
        payload.revision ??
        (payload.revisions as Record<string, unknown> | undefined)?.[id];
      const patch = method === "updateShot" ? shotPatch(payload.patch) : {};
      return mutateProject(payload, method, (record, state) => {
        const shot = record.shots.find((shot) => shot.id === id);
        if (!shot) throw new Error("镜头不存在，请刷新后重试");
        revision(shot, expected);
        const now = new Date().toISOString();
        if (method === "deleteShot") {
          record.shots = record.shots.filter((shot) => shot.id !== id);
          for (const asset of record.assets)
            if (asset.shotId === id) {
              delete asset.shotId;
              asset.updatedAt = now;
              asset.revision++;
            }
          if (
            state.settings.receiveProjectId === record.project.id &&
            state.settings.receiveShotId === id
          )
            state.settings.receiveShotId = "";
        } else {
          if (
            patch.assetIds?.some(
              (id) =>
                !record.assets.some(
                  (asset) => asset.id === id && !asset.trashedAt,
                ),
            )
          )
            throw new Error("关联的素材不存在或已在回收站");
          Object.assign(shot, patch);
          shot.revision++;
          shot.updatedAt = now;
        }
        activity(
          record,
          state,
          method,
          `${method === "deleteShot" ? "删除" : "更新"}「${shot.title}」`,
          { shotId: id },
        );
        return { ok: true };
      });
    }
    case "saveSettings": {
      const patch = object(payload.patch, "设置");
      const allowed = new Set([
        "displayName",
        "inboxPath",
        "receiveProjectId",
        "receiveShotId",
        "notifications",
        "background",
        "mutedProjects",
        "lastSeen",
        "api",
      ]);
      for (const key of Object.keys(patch))
        if (!allowed.has(key)) throw new Error(`不允许修改设置字段：${key}`);
      for (const key of [
        "displayName",
        "inboxPath",
        "receiveProjectId",
        "receiveShotId",
      ])
        if (key in patch) string(patch[key], key, key !== "displayName");
      for (const key of ["notifications", "background"])
        if (key in patch && typeof patch[key] !== "boolean")
          throw new Error(`${key}必须为布尔值`);
      if (patch.inboxPath)
        throw new Error("监控收件箱路径需要桌面端，请在桌面端选择文件夹");
      if (
        "mutedProjects" in patch &&
        (!Array.isArray(patch.mutedProjects) ||
          patch.mutedProjects.some((id) => typeof id !== "string"))
      )
        throw new Error("静音项目必须是 ID 数组");
      const seen =
        patch.lastSeen === undefined
          ? undefined
          : object(patch.lastSeen, "已读时间");
      if (seen)
        for (const timestamp of Object.values(seen))
          if (
            typeof timestamp !== "string" ||
            !Number.isFinite(Date.parse(timestamp))
          )
            throw new Error("已读时间无效");
      const api =
        patch.api === undefined ? undefined : object(patch.api, "API 设置");
      if (api) {
        if (api.key !== undefined && api.key !== "")
          throw new Error("API 密钥只能在桌面端安全保存，请在桌面端设置");
        for (const key of Object.keys(api))
          if (!["baseUrl", "model", "key", "hasKey", "enabled"].includes(key))
            throw new Error(`API 设置字段无效：${key}`);
        for (const key of ["baseUrl", "model"])
          if (key in api) string(api[key], key, true);
        if ("enabled" in api && typeof api.enabled !== "boolean")
          throw new Error("API enabled 必须为布尔值");
      }
      const result = await transaction("readwrite", async (tx) => {
        const state = await meta(tx);
        const next = { ...state.settings, ...patch } as Settings;
        if (seen)
          next.lastSeen = { ...state.settings.lastSeen, ...seen } as Record<
            string,
            string
          >;
        if (api) {
          const { key: _secret, hasKey: _hasKey, ...safe } = api;
          next.api = {
            baseUrl: "",
            model: "",
            enabled: false,
            ...state.settings.api,
            ...safe,
            hasKey: false,
          };
        }
        const receivesChanged =
          next.receiveProjectId !== state.settings.receiveProjectId;
        if (receivesChanged && !("receiveShotId" in patch))
          next.receiveShotId = "";
        if (next.receiveProjectId) {
          const target = await project(tx, next.receiveProjectId);
          if (
            next.receiveShotId &&
            !target.shots.some((shot) => shot.id === next.receiveShotId)
          )
            throw new Error("接收镜头不存在");
        } else if (next.receiveShotId) throw new Error("请先选择接收项目");
        state.settings = next;
        tx.objectStore("meta").put(state);
        return next;
      });
      changed({ type: "settings.updated" });
      return result;
    }
    case "readDocument":
    case "revealAsset": {
      const loaded = await transaction("readonly", async (tx) => {
        const record = await project(tx, payload.projectId);
        const asset = record.assets.find((asset) => asset.id === payload.id);
        if (!asset || asset.trashedAt)
          throw new Error("素材不存在或已在回收站，请先恢复");
        const stored = await request<StoredBlob | undefined>(
          tx.objectStore("blobs").get([record.project.id, asset.id]),
        );
        if (!stored || stored.hash !== asset.hash)
          throw new Error("素材原文件缺失，请重新导入");
        return { asset, blob: stored.blob };
      });
      if (method === "revealAsset") {
        download(loaded.blob, loaded.asset.name);
        return { ok: true, downloaded: true };
      }
      if (
        !["text/plain", "text/markdown", "application/json"].includes(
          loaded.asset.mime,
        )
      )
        throw new Error(
          "浏览器仅支持读取 TXT/MD/JSON 文本，请下载 PDF/Word 后打开",
        );
      if (loaded.blob.size > 2 * 1024 * 1024)
        throw new Error("文档超过 2 MiB，请下载后打开");
      return loaded.blob.text();
    }
    case "exportBackup": {
      const data = await browserProjectData(String(payload.projectId));
      const includeTrash = payload.includeTrash !== false;
      const backup = includeTrash ? data : backupWithoutTrash(data.record, data.media);
      if (backup.media.reduce((sum, item) => sum + item.blob.size, 0) >= 512 * 1024 * 1024)
        throw new Error("原片已超过浏览器 ZIP 恢复的 512 MB 上限；请在设置中另存到本地文件夹，并备份整个项目文件夹。");
      const archive = await buildBackup(backup.record, backup.media);
      // Use the actual recovery reader before offering a recovery package.
      const verified = await parseProjectArchive(archive);
      if (verified.record.assets.length !== backup.record.assets.length || verified.record.assets.filter(asset => asset.trashedAt).length !== backup.record.assets.filter(asset => asset.trashedAt).length)
        throw new Error("备份回读数量不一致，未提供不完整的备份");
      download(archive, `${data.record.project.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")}_${includeTrash ? "完整备份" : "备份（不含回收站）"}.zip`);
      return { verified: true, downloaded: true, assetCount: verified.media.length, trashCount: verified.record.assets.filter(asset => asset.trashedAt).length, includeTrash, paragraphCount: verified.record.editing?.paragraphs.length || 0, size: archive.size, createdAt: new Date().toISOString() };
    }
    case "exportProject": {
      if (payload.format === "folder")
        throw new Error(
          "浏览器无法直接导出项目文件夹，请选择 ZIP 并解压，或在桌面端导出文件夹",
        );
      if (payload.format !== "zip") throw new Error("请选择 ZIP 导出格式");
      const include = {
        assets: false,
        originals: false,
        storyboard: false,
        scripts: false,
        videos: false,
        ...(payload.include === undefined
          ? {}
          : object(payload.include, "导出选项")),
      };
      for (const key of Object.keys(include))
        if (
          !["assets", "originals", "storyboard", "scripts", "videos"].includes(
            key,
          ) ||
          typeof include[key as keyof typeof include] !== "boolean"
        )
          throw new Error("导出选项无效");
      const loaded = await transaction("readonly", async (tx) => {
        const record = await project(tx, payload.projectId);
        const assets = record.assets.filter(
          (asset) =>
            !asset.trashedAt &&
            (include.originals ||
              ((asset.kind === "document" || asset.category === "script") &&
                include.scripts) ||
              (asset.kind === "video" && include.videos) ||
              ((asset.kind === "image" || asset.kind === "audio") &&
                include.assets)),
        );
        const blobs = await Promise.all(
          assets.map((asset) =>
            request<StoredBlob | undefined>(
              tx.objectStore("blobs").get([record.project.id, asset.id]),
            ),
          ),
        );
        return { record, assets, blobs };
      });
      const entries: ZipEntry[] = [];
      const json = (name: string, value: unknown) =>
        entries.push({
          name,
          bytes: new TextEncoder().encode(JSON.stringify(value, null, 2)),
        });
      // An exported folder is an independent copy, so registering it on desktop
      // must not replace the original project or claim its public-inbox identity.
      const portable = {
        id: crypto.randomUUID(),
        name: loaded.record.project.name,
        createdAt: loaded.record.project.createdAt,
        schemaVersion: loaded.record.project.schemaVersion,
        originProjectId: loaded.record.project.id,
      };
      json("weave.project.json", portable);
      const portableAssets = namedExportPaths(loaded.assets).map(({ url: _url, ...asset }) => {
        if (!include.storyboard) delete asset.shotId;
        return asset;
      });
      const exportedIds = new Set(portableAssets.map((asset) => asset.id));
      const portableCanvas = canvasForExport(loaded.record.canvas, [...exportedIds]);
      if (portableCanvas) json("metadata/canvas.json", portableCanvas);
      const portableEditing = include.scripts
        ? editingForExport(loaded.record.editing, [...exportedIds])
        : undefined;
      if (portableEditing) json("metadata/editing.json", portableEditing);
      const portableShots = loaded.record.shots.map((shot) => ({
        ...shot,
        assetIds: shotAssetIds(shot, loaded.record.assets).filter((id) =>
          exportedIds.has(id),
        ),
      }));
      json("weave-manifest.json", {
        product: "Weave",
        exportedAt: new Date().toISOString(),
        project: portable,
        include,
        assets: portableAssets,
        shots: include.storyboard ? portableShots : [],
        editing: portableEditing,
        canvas: portableCanvas,
      });
      for (const [index, asset] of portableAssets.entries()) {
        const stored = loaded.blobs[index];
        if (!stored || stored.hash !== asset.hash)
          throw new Error(`无法导出，原文件缺失：${asset.name}`);
        json(`metadata/assets/${asset.id}.json`, asset);
        entries.push({
          name: portableAssets[index].relativePath,
          bytes: new Uint8Array(await stored.blob.arrayBuffer()),
          modifiedAt: new Date(asset.createdAt),
        });
      }
      for (const event of loaded.record.activities)
        json(`activity/${event.id}.json`, event);
      if (include.scripts) {
        const shots = [...loaded.record.shots].sort(
          (a, b) =>
            (a.order ?? 0) - (b.order ?? 0) ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        );
        const markdown = [
          `# ${loaded.record.project.name}`,
          "",
          ...shots.flatMap((shot, index) => [
            `## ${index + 1}. ${shot.title}`,
            "",
            `时长：${shot.duration} 秒`,
            "",
            "### 描述",
            "",
            shot.description || "（未填写）",
            "",
            "### 对白",
            "",
            shot.dialogue || "（未填写）",
            "",
            "### 提示词",
            "",
            shot.prompt || "（未填写）",
            "",
          ]),
        ].join("\n");
        entries.push({
          name: "scripts/storyboard.md",
          bytes: new TextEncoder().encode(markdown),
        });
      }
      if (include.storyboard) {
        for (const shot of portableShots)
          json(`metadata/shots/${shot.id}.json`, shot);
        if (
          payload.storyboardFiles !== undefined &&
          !Array.isArray(payload.storyboardFiles)
        )
          throw new Error("分镜导出文件无效");
        for (const input of (payload.storyboardFiles as
          | unknown[]
          | undefined) || []) {
          const file = object(input, "分镜文件");
          entries.push({
            name: `storyboard/${fileName(file.name)}`,
            bytes: byteArray(file.bytes),
          });
        }
      }
      const archive = createZip(entries);
      download(
        archive,
        `${loaded.record.project.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_") || "Weave"}_Weave.zip`,
      );
      await mutateProject(payload, "project.exported", (record, state) => {
        activity(record, state, "project.exported", "导出项目 ZIP");
      });
      return { ok: true, downloaded: true, fileCount: entries.length };
    }
    default:
      throw new Error(`浏览器不支持此操作：${method}。请使用桌面端`);
  }
}
