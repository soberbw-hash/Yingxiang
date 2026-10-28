import type { Asset, EditDocument } from "../types";
import { validateEditing } from "../../shared/editing.mjs";
import { createZip, type ZipEntry } from "./zip.ts";
import { hashBlob, safePart } from "./directoryFiles.ts";
import { stackMembers, syncStackLinks } from "../../shared/asset-stacks.mjs";

const html = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
const folder = (asset: Asset) =>
  asset.kind === "video" ? "视频" : asset.kind === "audio" ? "音频" : "图片";
export async function buildEditingHandoff(
  document: EditDocument,
  assets: Asset[],
  read: (asset: Asset) => Promise<Blob>,
) {
  const doc = validateEditing(syncStackLinks(document, assets, false), assets);
  const active = new Map(
    assets
      .filter((asset) => !asset.trashedAt)
      .map((asset) => [asset.id, asset]),
  );
  const used = [
    ...new Set(
      doc.paragraphs.flatMap((paragraph) =>
        paragraph.links.map((link) => link.assetId),
      ),
    ),
  ];
  if (used.some((id) => !active.has(id)))
    throw new Error("有对应素材在回收站或不可用，请先恢复或解除关联后再交接");
  if (
    used.reduce((sum, id) => sum + active.get(id)!.size, 0) >
    300 * 1024 * 1024
  )
    throw new Error(
      "交接素材超过 300 MB，请分项目导出；本机浏览器打包需要内存，未生成不完整的包",
    );
  const paths = new Map<string, string>();
  const entries: ZipEntry[] = [],
    manifest: {
      id: string;
      path: string;
      hash: string;
      name: string;
      stackId?: string;
      final?: boolean;
    }[] = [];
  for (const id of used) {
    const asset = active.get(id)!,
      blob = await read(asset);
    if (blob.size !== asset.size || (await hashBlob(blob)) !== asset.hash)
      throw new Error(`原片校验失败：${asset.name}，未导出错误文件`);
    const dot = asset.name.lastIndexOf("."),
      ext = asset.name.slice(dot + 1).toLowerCase();
    if (!/^[a-z0-9]{1,10}$/.test(ext)) throw new Error("素材扩展名无效");
    const path = `素材/${folder(asset)}/${safePart(asset.name.slice(0, dot))}__${asset.id}.${ext}`;
    paths.set(id, path);
    manifest.push({
      id,
      path,
      hash: asset.hash,
      name: asset.name,
      ...(asset.stackId
        ? { stackId: asset.stackId, final: asset.status === "final" }
        : {}),
    });
    entries.push({
      name: path,
      bytes: new Uint8Array(await blob.arrayBuffer()),
    });
  }
  const rows = doc.paragraphs
    .map((p, index) => {
      const links = [...p.links].sort(
        (a, b) => Number(b.role === "primary") - Number(a.role === "primary"),
      );
      const body = html(p.text);
      return `<section><div><small>${String(index + 1).padStart(2, "0")} · ${p.generated ? "已生成" : "待准备"}</small><p class="copy ${p.generated ? "done" : ""}">${body}</p>${p.notes.map((note) => `<aside>${note.quote ? `<blockquote>${html(note.quote)}</blockquote>` : ""}<p>${html(note.text)}</p><small>${note.resolved ? "已处理" : "待处理"}</small></aside>`).join("")}</div><div class="media">${
        links
          .map((link) => {
            const asset = active.get(link.assetId)!,
              path = paths.get(asset.id)!,
              url = path.split("/").map(encodeURIComponent).join("/");
            return `<figure><figcaption>${link.role === "primary" ? "★ 主选" : "备选"} · ${html(asset.name)}</figcaption>${asset.kind === "image" ? `<a href="${url}"><img loading="lazy" src="${url}" alt="${html(asset.name)}"></a>` : asset.kind === "video" ? `<video controls preload="metadata" src="${url}"></video>` : `<audio controls preload="metadata" src="${url}"></audio>`}<a download href="${url}">原文件</a></figure>`;
          })
          .join("") || "<small>未关联素材</small>"
      }</div></section>`;
    })
    .join("");
  const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; media-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${html(doc.title)} · 剪辑对照</title><style>body{margin:0;background:#f6f7fa;color:#242632;font:14px/1.65 system-ui,sans-serif}main{max-width:1300px;margin:auto;padding:28px}h1{font-size:22px}section{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr);gap:24px;background:white;border:1px solid #e2e4ec;border-radius:12px;padding:20px;margin:14px 0}p{margin:8px 0;overflow-wrap:anywhere}.copy,aside{white-space:pre-wrap}small{color:#667085}mark,.done{background:#e8f4ed;color:#254f39}aside{border-left:3px solid #d5cfee;padding:4px 12px;margin:12px 0}blockquote{margin:4px 0;color:#667085}.media{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}figure{margin:0;border:1px solid #e2e4ec;border-radius:8px;overflow:hidden}figcaption{padding:8px;font-size:12px;overflow-wrap:anywhere}img,video{width:100%;max-height:280px;object-fit:contain;background:#f7f7fa}audio{width:100%;max-width:100%}a{color:#6252c8;font-size:12px}figure>a:last-child{display:block;padding:6px 8px}@media(max-width:700px){main{padding:14px}section{grid-template-columns:1fr}}</style></head><body><main><h1>${html(doc.title)}</h1><small>剪辑对照 · ${doc.paragraphs.length} 段 · 解压整个文件夹后打开此页</small>${rows}</main></body></html>`;
  const encode = new TextEncoder();
  entries.push(
    { name: "剪辑对照.html", bytes: encode.encode(page) },
    {
      name: "交接清单.json",
      bytes: encode.encode(
        JSON.stringify(
          {
            version: 1,
            title: doc.title,
            // Legacy partial marks stay in full project backups, not editing handoffs.
            paragraphs: doc.paragraphs.map((p) => ({ ...p, marks: [] })),
            files: manifest,
          },
          null,
          2,
        ),
      ),
    },
    {
      name: "文稿.txt",
      bytes: encode.encode(doc.paragraphs.map((p) => p.text).join("\n\n")),
    },
  );
  return {
    blob: createZip(entries),
    fileCount: used.length,
    name: `${safePart(doc.title)}-剪辑交接.zip`,
  };
}

/** Export only the current video references used by the editing document. */
export function planEditingVideos(
  document: EditDocument,
  assets: Asset[],
) {
  const doc = validateEditing(syncStackLinks(document, assets, false), assets);
  const active = new Map(
    assets.filter((asset) => !asset.trashedAt).map((asset) => [asset.id, asset]),
  );
  const all = new Map(assets.map((asset) => [asset.id, asset]));
  const videos: { paragraph: number; asset: Asset; option: number; options: number }[] = [];

  doc.paragraphs.forEach((paragraph, paragraphIndex) => {
    const candidates: Asset[] = [];
    const seenGroups = new Set<string>();
    for (const link of paragraph.links) {
      const linked = all.get(link.assetId);
      if (!linked || linked.kind !== "video") continue;
      if (linked.trashedAt || !active.has(linked.id))
        throw new Error(`第 ${paragraphIndex + 1} 段关联的视频已在回收站，请恢复或解除关联`);
      const groupKey = linked.stackId || linked.id;
      if (seenGroups.has(groupKey)) continue;
      seenGroups.add(groupKey);
      const current = linked.stackId ? stackMembers(linked, assets)[0] : linked;
      if (!current || current.trashedAt)
        throw new Error(`第 ${paragraphIndex + 1} 段的视频版本不可用`);
      candidates.push(current);
    }
    candidates.forEach((asset, index) =>
      videos.push({
        paragraph: paragraphIndex + 1,
        asset,
        option: index + 1,
        options: candidates.length,
      }),
    );
  });

  const width = Math.max(2, String(doc.paragraphs.length).length);
  const files = videos.map(item => {
    const { asset } = item;
    const dot = asset.name.lastIndexOf(".");
    const ext = asset.name.slice(dot + 1).toLowerCase();
    if (dot < 1 || !/^[a-z0-9]{1,10}$/.test(ext))
      throw new Error(`视频扩展名无效：${asset.name}`);
    const prefix = String(item.paragraph).padStart(width, "0") +
      (item.options > 1 ? `-${item.option}` : "");
    const filename = `${prefix}_${safePart(asset.name.slice(0, dot))}.${ext}`;
    return { ...item, filename };
  });
  const linked = new Set(files.map(file => file.paragraph));
  return { files, totalBytes: files.reduce((sum, file) => sum + file.asset.size, 0),
    withoutVideo: doc.paragraphs.map((_, i) => i + 1).filter(number => !linked.has(number)) };
}

export async function buildEditingVideos(
  document: EditDocument,
  assets: Asset[],
  read: (asset: Asset) => Promise<Blob>,
) {
  const plan = planEditingVideos(document, assets);
  if (!plan.files.length) throw new Error("剪辑对照里还没有关联视频可导出");
  if (plan.totalBytes > 300 * 1024 * 1024)
    throw new Error("关联视频超过 300 MB，请分批导出；本机浏览器打包需要内存，未生成不完整的包");
  const entries: ZipEntry[] = [];
  for (const { asset, filename } of plan.files) {
    const blob = await read(asset);
    if (blob.size !== asset.size || (await hashBlob(blob)) !== asset.hash)
      throw new Error(`原片校验失败：${asset.name}，未导出错误文件`);
    entries.push({
      name: `剪辑视频/${filename}`,
      bytes: new Uint8Array(await blob.arrayBuffer()),
    });
  }
  return {
    blob: createZip(entries),
    fileCount: entries.length,
    name: `${safePart(document.title)}-剪辑视频.zip`,
  };
}

export function downloadHandoff(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
