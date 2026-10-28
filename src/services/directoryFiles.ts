// Structural interfaces keep the disk protocol testable without browser globals.
export interface DiskFile {
  kind: "file";
  name: string;
  getFile(): Promise<Blob>;
  createWritable(): Promise<{
    write(data: Blob | string): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
}
export interface DiskDirectory {
  kind: "directory";
  name: string;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<DiskDirectory>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<DiskFile>;
  removeEntry(name: string): Promise<void>;
  values(): AsyncIterable<DiskDirectory | DiskFile>;
  queryPermission?(options: {
    mode: "read" | "readwrite";
  }): Promise<PermissionState>;
  requestPermission?(options: {
    mode: "read" | "readwrite";
  }): Promise<PermissionState>;
  isSameEntry?(other: DiskDirectory): Promise<boolean>;
  resolve?(other: DiskDirectory): Promise<string[] | null>;
}

export function safePart(value: string) {
  const cleaned = value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/, "")
    .slice(0, 90);
  return !cleaned || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(cleaned)
    ? `素材_${cleaned}`
    : cleaned;
}
export function pathParts(path: string) {
  const parts = path.split("/");
  if (
    !parts.length ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\\:\u0000-\u001f]/.test(part),
    )
  )
    throw new Error("素材路径不安全，未访问目录外的文件");
  return parts;
}
async function parent(root: DiskDirectory, path: string, create = false) {
  const parts = pathParts(path);
  const name = parts.pop()!;
  let directory = root;
  for (const part of parts)
    directory = await directory.getDirectoryHandle(part, { create });
  return { directory, name };
}
export async function readDiskFile(root: DiskDirectory, path: string) {
  const { directory, name } = await parent(root, path);
  return (await directory.getFileHandle(name)).getFile();
}
export function isMissing(error: unknown) {
  return (error as { name?: string })?.name === "NotFoundError";
}
export async function optionalJson(
  root: DiskDirectory,
  path: string,
): Promise<any | undefined> {
  try {
    const file = await readDiskFile(root, path);
    if (file.size > 16 * 1024 * 1024)
      throw new Error("记录文件过大，已停止读取");
    return JSON.parse(await file.text());
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
export async function writeDiskFile(
  root: DiskDirectory,
  path: string,
  data: Blob | string,
  exclusive = false,
) {
  const { directory, name } = await parent(root, path, true);
  if (exclusive) {
    try {
      await directory.getFileHandle(name);
      throw new Error("目标文件已存在，未覆盖");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  const writer = await (
    await directory.getFileHandle(name, { create: true })
  ).createWritable();
  try {
    await writer.write(data);
    await writer.close();
  } catch (error) {
    await writer.abort?.().catch(() => {});
    // Only our newly created, unpublished file. Never remove a prior user file.
    if (exclusive) await directory.removeEntry(name).catch(() => {});
    throw error;
  }
}
export async function hashBlob(blob: Blob) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function writeVerified(
  root: DiskDirectory,
  path: string,
  blob: Blob,
  hash: string,
) {
  if ((await hashBlob(blob)) !== hash)
    throw new Error("原文件校验不一致，未保存");
  try {
    const existing = await readDiskFile(root, path);
    if ((await hashBlob(existing)) !== hash)
      throw new Error("目标文件内容已被修改，未覆盖");
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await writeDiskFile(root, path, blob, true);
  if ((await hashBlob(await readDiskFile(root, path))) !== hash)
    throw new Error("写入校验失败，原项目保持不变");
}
export function historyPath(asset: { id: string; hash: string; name: string }) {
  const ext = asset.name.split(".").pop()?.toLowerCase() || "bin";
  if (
    !/^[a-f0-9-]{36}$/i.test(asset.id) ||
    !/^[a-f0-9]{64}$/i.test(asset.hash) ||
    !/^[a-z0-9]{1,10}$/.test(ext)
  )
    throw new Error("历史素材标识无效");
  return `_Weave/历史原片/${asset.id}/${asset.hash}.${ext}`;
}
export async function readVersionFile(
  root: DiskDirectory,
  path: string,
  asset: { id: string; hash: string; name: string },
) {
  try {
    return await readDiskFile(root, path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return readDiskFile(root, historyPath(asset));
  }
}
export async function archivePreviousPath(
  root: DiskDirectory,
  oldPath: string,
  currentPath: string,
  asset: { id: string; hash: string; name: string },
) {
  if (oldPath === currentPath) return;
  const old = await readDiskFile(root, oldPath);
  if (
    (await hashBlob(old)) !== asset.hash ||
    (await hashBlob(await readDiskFile(root, currentPath))) !== asset.hash
  )
    throw new Error("旧路径归档校验不符，原文件保留");
  await writeVerified(root, historyPath(asset), old, asset.hash);
  const { directory, name } = await parent(root, oldPath);
  // Both the new classified copy and recoverable history have been verified.
  await directory.removeEntry(name);
}
export type DiskCommit<T> = {
  format: "weave-disk-commit";
  schemaVersion: 1;
  id: string;
  parent: string | null;
  createdAt: string;
  clientId: string;
  data: T;
  checksum: string;
};
export async function appendCommit<T>(
  root: DiskDirectory,
  data: T,
  parentId: string | null,
  clientId: string,
): Promise<DiskCommit<T>> {
  const content = {
    format: "weave-disk-commit" as const,
    schemaVersion: 1 as const,
    id: crypto.randomUUID(),
    parent: parentId,
    createdAt: new Date().toISOString(),
    clientId,
    data,
  };
  const commit = {
    ...content,
    checksum: await hashBlob(new Blob([JSON.stringify(content)])),
  };
  const path = `_Weave/提交/${commit.id}.json`;
  const serialized = JSON.stringify(commit, null, 2);
  if (new Blob([serialized]).size > 16 * 1024 * 1024)
    throw new Error("提交记录过大，尚未发布；请拆分项目或减少本次操作数量");
  await writeDiskFile(root, path, serialized, true);
  const saved = await optionalJson(root, path);
  if (!saved || saved.checksum !== commit.checksum)
    throw new Error("提交未完整保存，请重试");
  return commit;
}
export async function readCommits<T>(
  root: DiskDirectory,
): Promise<DiskCommit<T>[]> {
  let directory: DiskDirectory;
  try {
    directory = await (
      await root.getDirectoryHandle("_Weave")
    ).getDirectoryHandle("提交");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const commits: DiskCommit<T>[] = [];
  for await (const entry of directory.values()) {
    if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
    const file = await entry.getFile();
    if (file.size === 0) continue; // newly created handle, not yet closed/committed
    if (file.size > 16 * 1024 * 1024)
      throw new Error("共享记录过大，已停止读取");
    let commit: DiskCommit<T>;
    try {
      commit = JSON.parse(await file.text());
    } catch {
      throw new Error(
        "发现未完成的目录提交，原文件未修改；请稍后刷新，若持续出现请保留目录备份",
      );
    }
    if (commit.format !== "weave-disk-commit" || commit.schemaVersion !== 1)
      throw new Error(
        "此目录使用了更新或未知的数据格式，请更新映箱；未修改数据",
      );
    const { checksum, ...content } = commit;
    if (
      typeof checksum !== "string" ||
      (await hashBlob(new Blob([JSON.stringify(content)]))) !== checksum ||
      entry.name !== `${commit.id}.json`
    )
      throw new Error("目录提交校验失败，已停止读取，未覆盖原数据");
    commits.push(commit);
  }
  return commits;
}

export async function directoryPermission(
  root: DiskDirectory,
  write: boolean,
  prompt = false,
) {
  const options = { mode: write ? ("readwrite" as const) : ("read" as const) };
  if (!root.queryPermission) return;
  let state = await root.queryPermission(options);
  if (state !== "granted" && prompt)
    state = await root.requestPermission!(options);
  if (state !== "granted")
    throw new Error("目录授权已失效，请点击「重新授权」；不要清除浏览器数据");
}
export function pickDirectory(readOnly = false): Promise<DiskDirectory> {
  const picker = (
    window as unknown as {
      showDirectoryPicker?: (options: {
        mode: string;
      }) => Promise<DiskDirectory>;
    }
  ).showDirectoryPicker;
  if (!picker)
    return Promise.reject(
      new Error(
        "此打开方式不支持目录授权。请使用公司允许的 Chrome/Edge 与获批安全地址；不会绕过浏览器策略。",
      ),
    );
  // Must run directly inside the user's click, before queues or unrelated awaits.
  return picker.call(window, { mode: readOnly ? "read" : "readwrite" });
}
export function directoryAccessMessage() {
  if (typeof window === "undefined" || !window.isSecureContext)
    return "此打开方式缺少安全环境，无法授权目录；请使用公司允许的安全地址，不要关闭浏览器安全检查。";
  if (
    !(window as unknown as { showDirectoryPicker?: unknown })
      .showDirectoryPicker
  )
    return "当前浏览器环境未提供目录选择；现有浏览器项目仍保留，不能仅输入路径代替授权。";
  return "当前环境提供目录选择；仍需你明确授权，实际共享盘权限由 Windows 和公司策略决定。";
}
