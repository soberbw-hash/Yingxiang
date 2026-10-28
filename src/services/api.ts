import { browserOnChanged } from "./browserRepository";
import { folderBrowserInvoke } from "./folderBrowser";
import type { ImportFile } from "../types";

export const isDesktop = Boolean(window.weaveDesktop);
export function supportedFile(file: File) {
  const ext = file.name.split(".").pop()?.toLowerCase();
  return (
    file.type.startsWith("image/") ||
    file.type.startsWith("video/") ||
    file.type.startsWith("audio/") ||
    [
      "png",
      "jpg",
      "jpeg",
      "webp",
      "gif",
      "bmp",
      "avif",
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
      "json",
      "pdf",
      "doc",
      "docx",
    ].includes(ext || "")
  );
}
export async function invoke(
  method: string,
  payload: Record<string, unknown> = {},
) {
  try {
    return await (window.weaveDesktop
      ? window.weaveDesktop.invoke(method, payload)
      : folderBrowserInvoke(method, payload));
  } catch (error) {
    const message = String((error as Error).message || error);
    const explanations: [RegExp, string][] = [
      [
        /CONFLICT:/,
        "这条内容已被其他人修改。最新内容会重新载入，请检查后再保存。",
      ],
      [/BUSY:/, "项目正在由另一位创作者保存，请稍后重试。"],
      [
        /DUPLICATE_PROJECT:/,
        "这个项目已在另一位置打开。请使用导出的独立副本，或在搬迁后重新打开。",
      ],
      [/EXISTS:/, "请选择空文件夹创建项目；已有项目请使用「打开项目文件夹」。"],
      [/ENCRYPTION_UNAVAILABLE:/, "系统密钥保护暂不可用，密钥没有保存。"],
      [/TARGET_TRASHED:/, "目标项目的相同素材在回收站里，请先恢复它。"],
      [
        /UNSUPPORTED:/,
        "此格式无法在软件内预览，请打开文件位置后使用对应软件。",
      ],
      [
        /Only anonymous|supported direct media|Download failed|fetch failed|Failed to fetch|Download timed out|Private network addresses/,
        "无法读取这个素材直链。需要登录的网站，请下载文件后拖入。",
      ],
    ];
    throw new Error(
      explanations.find(([pattern]) => pattern.test(message))?.[1] || message,
    );
  }
}
export function onChanged(callback: (event: any) => void) {
  return window.weaveDesktop
    ? window.weaveDesktop.onChanged(callback)
    : browserOnChanged(callback);
}
export async function prepareFiles(
  files: File[],
): Promise<{ paths: string[]; files: ImportFile[] }> {
  const paths: string[] = [];
  const uploads: ImportFile[] = [];
  for (const file of files) {
    const path = window.weaveDesktop?.droppedFilePath(file);
    if (path) paths.push(path);
    else {
      if (isDesktop && file.size > 100 * 1024 * 1024)
        throw new Error(
          "粘贴内容超过 100 MB，请先保存为文件再拖入，以避免占用过多内存。",
        );
      uploads.push({
        name: file.name || `粘贴图片-${Date.now()}.png`,
        ...(isDesktop
          ? { bytes: Array.from(new Uint8Array(await file.arrayBuffer())) }
          : { blob: file }),
        source: "拖入 / 粘贴",
      });
    }
  }
  return { paths, files: uploads };
}
export async function prepareRemote(url: string): Promise<ImportFile> {
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol))
    throw new Error("请使用图片、视频或音频的 http / https 地址");
  if (isDesktop) return invoke("fetchRemote", { url });
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error("无法读取这个地址，请下载文件后拖入");
  if (Number(response.headers.get("content-length")) > 100 * 1024 * 1024)
    throw new Error("直链素材超过 100 MB，请下载文件后拖入。");
  const blob = await response.blob();
  if (blob.size > 100 * 1024 * 1024)
    throw new Error("直链素材超过 100 MB，请下载文件后拖入。");
  if (!blob.type.startsWith("image/") && !blob.type.startsWith("video/") && !blob.type.startsWith("audio/"))
    throw new Error("这不是直接的图片、视频或音频地址，请下载文件后拖入");
  const ext = ({ "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-wav": "wav" } as Record<string, string>)[blob.type] ||
    blob.type.split("/")[1]?.replace("jpeg", "jpg").split(";")[0] || "png";
  let name = decodeURIComponent(parsed.pathname.split("/").pop() || "网页素材");
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += `.${ext}`;
  return {
    name,
    blob,
    source: parsed.hostname,
  };
}
