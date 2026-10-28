import type { CSSProperties } from "react";
import type { AssetCategory } from "../types";

// One semantic palette for destinations, filters and asset frames.
// It describes stored classification, never changes or infers asset metadata.
export const assetCategoryThemes = {
  uncategorized: {
    label: "未分类",
    color: "灰",
    ink: "#687182",
    background: "#F6F7F9",
    border: "#CCD1D9",
  },
  character: {
    label: "角色",
    color: "紫",
    ink: "#7450B5",
    background: "#F5F0FC",
    border: "#C9B5E8",
  },
  product: {
    label: "产品", color: "蓝紫", ink: "#535DAB", background: "#F0F2FC", border: "#B9C1E5",
  },
  scene: {
    label: "场景",
    color: "绿",
    ink: "#2D7959",
    background: "#EEF6F1",
    border: "#A8CDB9",
  },
  prop: {
    label: "道具",
    color: "金棕",
    ink: "#8B641F",
    background: "#FBF5E9",
    border: "#DDC492",
  },
  storyboard: {
    label: "分镜",
    color: "蓝",
    ink: "#3D6FAB",
    background: "#EFF4FB",
    border: "#ADC5E4",
  },
  script: {
    label: "脚本",
    color: "玫瑰",
    ink: "#A05076",
    background: "#FAF0F5",
    border: "#DFB2C6",
  },
  video: {
    label: "视频",
    color: "青蓝",
    ink: "#267887",
    background: "#EDF6F8",
    border: "#A1CBD3",
  },
  audio: {
    label: "音频",
    color: "橙棕",
    ink: "#9A4D24",
    background: "#FCF2EB",
    border: "#E1BAA0",
  },
  other: {
    label: "其他",
    color: "石板",
    ink: "#4B647B",
    background: "#EFF3F6",
    border: "#B6C4D0",
  },
} as const satisfies Record<
  AssetCategory,
  {
    label: string;
    color: string;
    ink: string;
    background: string;
    border: string;
  }
>;

export function assetCategoryTheme(category: string) {
  if (category === "prop") return assetCategoryThemes.uncategorized;
  return Object.prototype.hasOwnProperty.call(assetCategoryThemes, category)
    ? assetCategoryThemes[category as AssetCategory]
    : assetCategoryThemes.uncategorized;
}

type CategoryStyle = CSSProperties &
  Record<"--category-ink" | "--category-bg" | "--category-border", string>;

export function assetCategoryStyle(category: string): CategoryStyle {
  const theme = assetCategoryTheme(category);
  return {
    "--category-ink": theme.ink,
    "--category-bg": theme.background,
    "--category-border": theme.border,
  };
}
