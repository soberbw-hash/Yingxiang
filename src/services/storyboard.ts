import type { Asset, ProjectSnapshot } from "../types";
import { shotAssetIds } from "../types";

function loadImage(asset: Asset): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error(`无法读取「${asset.name}」，请检查项目文件是否完整`));
    image.src = asset.url || "";
  });
}
export function getStoryboardEntries(snapshot: ProjectSnapshot) {
  const active = snapshot.assets.filter(
    (a) => !a.trashedAt && a.kind === "image" && a.status !== "rejected",
  );
  const orderedShots = [...snapshot.shots].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  const entries = orderedShots
    .map((shot) => {
      const linked = new Set(shotAssetIds(shot, snapshot.assets));
      const candidates = active.filter((a) => linked.has(a.id));
      return {
        title: shot.title,
        asset: candidates.find((a) => a.status === "final") || candidates[0],
      };
    })
    .filter((e): e is { title: string; asset: Asset } => Boolean(e.asset));
  if (!entries.length)
    active
      .filter((a) => a.category === "storyboard")
      .forEach((a) => entries.push({ title: a.name, asset: a }));
  return entries;
}
export async function renderStoryboard(
  snapshot: ProjectSnapshot,
  columns: number,
  labels: boolean,
  fit: "contain" | "cover",
) {
  const entries = getStoryboardEntries(snapshot);
  if (!entries.length)
    throw new Error("请先为镜头关联图片，或把图片归入「分镜」");
  if (
    labels &&
    !(await document.fonts.load('400 24px "Weave HarmonyOS Sans"')).length
  )
    throw new Error("鸿蒙字体未能加载，请重新打开映箱 后再导出分镜文字。");
  const files: { name: string; bytes: number[] }[] = [];
  const cellWidth = 640,
    cellHeight = 360,
    gap = 16,
    textHeight = labels ? 66 : 0;
  for (let offset = 0; offset < entries.length; offset += columns * columns) {
    const page = entries.slice(offset, offset + columns * columns);
    const canvas = document.createElement("canvas");
    canvas.width = columns * (cellWidth + gap) + gap;
    canvas.height = columns * (cellHeight + textHeight + gap) + gap;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建拼图画布");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < page.length; i++) {
      const image = await loadImage(page[i].asset);
      const x = gap + (i % columns) * (cellWidth + gap),
        y = gap + Math.floor(i / columns) * (cellHeight + textHeight + gap);
      ctx.fillStyle = "#f1f2f5";
      ctx.fillRect(x, y, cellWidth, cellHeight);
      const scale =
        fit === "cover"
          ? Math.max(cellWidth / image.width, cellHeight / image.height)
          : Math.min(cellWidth / image.width, cellHeight / image.height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, cellWidth, cellHeight);
      ctx.clip();
      ctx.drawImage(
        image,
        x + (cellWidth - image.width * scale) / 2,
        y + (cellHeight - image.height * scale) / 2,
        image.width * scale,
        image.height * scale,
      );
      ctx.restore();
      if (labels) {
        ctx.fillStyle = "#30313d";
        ctx.font = '400 24px "Weave HarmonyOS Sans", sans-serif';
        ctx.fillText(
          `${String(offset + i + 1).padStart(2, "0")}  ${page[i].title}`,
          x + 8,
          y + cellHeight + 38,
          cellWidth - 16,
        );
      }
    }
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("拼图生成失败"))),
        "image/png",
      ),
    );
    files.push({
      name: `分镜板-${String(files.length + 1).padStart(2, "0")}.png`,
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
    });
  }
  return files;
}
