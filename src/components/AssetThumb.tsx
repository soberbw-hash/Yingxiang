import {
  Check,
  Copy,
  FileText,
  MagnifyingGlass,
  Play,
  Stack,
  DownloadSimple,
  Star,
} from "@phosphor-icons/react";
import type { MouseEvent, DragEvent } from "react";
import type { Asset } from "../types";
import { formatSize } from "../types";
import { useEffect, useState } from "react";
import type { LibraryPreferences } from "../services/libraryPreferences";
import {
  writeAssetDrag,
  writeMediaFileDrag,
  downloadOriginal,
  prepareAudioDragFile,
  prepareVideoDragFile,
  startNativeAssetDrag,
} from "../services/assetOutbound";
import {
  assetCategoryStyle,
  assetCategoryTheme,
} from "../services/assetCategoryTheme";
import { AudioThumbnail } from "./AudioThumbnail";
import { originalTileSize } from "../services/libraryLayout";
import { bindDragCleanup } from "../services/dragLifecycle";

// Ratios are safe to reuse for the same original, even when a view unmounts.
const intrinsicRatios = new Map<string, number>();
function rememberRatio(key: string, ratio: number) {
  if (intrinsicRatios.size >= 2000 && !intrinsicRatios.has(key)) intrinsicRatios.delete(intrinsicRatios.keys().next().value!);
  intrinsicRatios.set(key, ratio);
}

export function AssetThumb({
  asset,
  selected,
  onSelect,
  onToggle,
  onPreview,
  onCopy,
  copyDisabled = false,
  onContextMenu,
  canPreview = true,
  display,
  onDragStart,
  stackCount = 1,
  onHistory,
  onStackDrop,
  onReorderDrop,
  onIntrinsicRatio,
  projectId,
  favorite = false,
  onFavorite,
}: {
  asset: Asset;
  selected: boolean;
  onSelect: (event: MouseEvent) => void;
  onToggle: () => void;
  onPreview: () => void;
  onCopy: (asset: Asset) => void;
  copyDisabled?: boolean;
  onContextMenu?: (event: MouseEvent) => void;
  canPreview?: boolean;
  display: LibraryPreferences;
  onDragStart?: (event: DragEvent) => void;
  stackCount?: number;
  onHistory?: () => void;
  onStackDrop?: (event: DragEvent) => void;
  onReorderDrop?: (event: DragEvent) => void;
  onIntrinsicRatio?: (ratio: number) => void;
  projectId?: string;
  favorite?: boolean;
  onFavorite?: () => void;
}) {
  const [dropHover, setDropHover] = useState(false);
  useEffect(
    () => bindDragCleanup(window, () => setDropHover(false)),
    [],
  );
  const [videoState, setVideoState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const ratioKey = `${asset.id}:${asset.hash || asset.url || ""}`;
  const initialRatio = intrinsicRatios.get(ratioKey) || (asset.width && asset.height ? asset.width / asset.height : undefined);
  const [ratio, setRatio] = useState(initialRatio || 1);
  const [ratioReady, setRatioReady] = useState(!!initialRatio || !["image", "video"].includes(asset.kind));
  return (
    <article
      className={`asset-card names-${display.names} ${selected ? "selected" : ""}`}
      style={assetCategoryStyle(asset.category)}
      tabIndex={0}
      aria-label={asset.name}
      aria-description={`${assetCategoryTheme(asset.category).label}素材`}
      data-category={asset.category}
      data-kind={asset.kind}
      data-original-size={originalTileSize(asset, ratio)}
      data-ratio-pending={display.layout === "original" && !ratioReady ? "true" : undefined}
      data-selected={selected}
      data-preview-asset={asset.id}
      data-stack-count={stackCount}
      data-stack-hover={dropHover || undefined}
      onPointerEnter={() => {
        if (canPreview && asset.kind === "audio")
          void prepareAudioDragFile(asset).catch(() => {});
        if (canPreview && asset.kind === "video")
          void prepareVideoDragFile(asset).catch(() => {});
      }}
      onFocus={() => {
        if (canPreview && asset.kind === "audio")
          void prepareAudioDragFile(asset).catch(() => {});
        if (canPreview && asset.kind === "video")
          void prepareVideoDragFile(asset).catch(() => {});
      }}
      onClick={onSelect}
      onDoubleClick={canPreview ? onPreview : undefined}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && canPreview && e.key === "Enter") {
          e.preventDefault();
          onPreview();
        }
      }}
      draggable
      onDragEnter={(event) => {
        if (onReorderDrop && event.dataTransfer.types.includes("application/weave-assets")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
        if (
          onStackDrop &&
          event.dataTransfer.types.some(
            (type) => type === "Files" || type === "application/weave-assets",
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragOver={(event) => {
        if (onReorderDrop && event.dataTransfer.types.includes("application/weave-assets")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
        if (
          onStackDrop &&
          event.dataTransfer.types.some(
            (type) => type === "Files" || type === "application/weave-assets",
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
          setDropHover(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          setDropHover(false);
      }}
      onDrop={(event) => {
        if (onReorderDrop && event.dataTransfer.types.includes("application/weave-assets")) {
          event.preventDefault();
          event.stopPropagation();
          onReorderDrop(event);
          return;
        }
        if (onStackDrop) {
          event.preventDefault();
          event.stopPropagation();
          setDropHover(false);
          onStackDrop(event);
        }
      }}
      onDragStart={(e) => {
        if (!asset.trashedAt && startNativeAssetDrag(e, projectId, asset.id))
          return;
        if (onDragStart) onDragStart(e);
        else writeAssetDrag(e.dataTransfer, [asset]);
        writeMediaFileDrag(e.dataTransfer, asset);
      }}
    >
      <div
        className="asset-picture"
        style={{
          aspectRatio:
            asset.kind === "audio"
              ? 2.6
              : display.layout === "original"
                ? ratio
                : 1,
        }}
      >
        {asset.kind === "image" ? (
          <img
            src={asset.url}
            alt={asset.name}
            loading="lazy"
            draggable={canPreview}
            title="按住图片拖到上传区域；外部一次一张"
            onLoad={(event) => {
              const image = event.currentTarget;
              if (image.naturalWidth && image.naturalHeight) {
                const nextRatio = image.naturalWidth / image.naturalHeight;
                rememberRatio(ratioKey, nextRatio);
                setRatio(nextRatio);
                setRatioReady(true);
                onIntrinsicRatio?.(nextRatio);
              }
            }}
            onError={() => setRatioReady(true)}
          />
        ) : asset.kind === "video" ? (
          <video
            src={asset.url}
            preload="metadata"
            muted
            draggable={false}
            onLoadedMetadata={(e) => {
              if (e.currentTarget.videoWidth && e.currentTarget.videoHeight) {
                const nextRatio = e.currentTarget.videoWidth / e.currentTarget.videoHeight;
                rememberRatio(ratioKey, nextRatio);
                setRatio(nextRatio);
                setRatioReady(true);
                onIntrinsicRatio?.(nextRatio);
              }
              const video = e.currentTarget;
              const seekTo = Math.min(0.2, video.duration / 2);
              if (!Number.isFinite(seekTo) || seekTo <= 0) {
                setVideoState("ready");
                return;
              }
              try {
                video.currentTime = seekTo;
              } catch {
                setVideoState("error");
              }
            }}
            onSeeked={() => setVideoState("ready")}
            onError={() => { setVideoState("error"); setRatioReady(true); }}
          />
        ) : asset.kind === "audio" ? (
          <AudioThumbnail asset={asset} />
        ) : (
          <div className="document-picture">
            <FileText size={38} weight="duotone" />
            <span>{asset.name.split(".").pop()?.toUpperCase()}</span>
          </div>
        )}
        {asset.kind === "video" && videoState !== "ready" && (
          <div
            className={`video-thumb-fallback ${videoState === "error" ? "is-error" : ""}`}
            aria-label={
              videoState === "error" ? "视频预览不可用" : "正在读取视频预览"
            }
          >
            <Play size={26} weight="fill" aria-hidden="true" />
            <span>
              {videoState === "error" ? "预览不可用" : "正在读取预览"}
            </span>
          </div>
        )}
        <button
          className={`check-button ${selected ? "checked" : ""}`}
          aria-label={`${selected ? "取消选择" : "选择"} ${asset.name}`}
          aria-pressed={selected}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          {selected && <Check size={12} weight="bold" />}
        </button>
        {onFavorite && <button type="button" className={`asset-favorite ${favorite ? "is-favorite" : ""}`} aria-pressed={favorite} aria-label={`${favorite ? "取消收藏" : "收藏"} ${asset.name}`} title={favorite ? "取消收藏" : "收藏素材"} draggable={false}
          onPointerDown={event => event.stopPropagation()} onDragStart={event => { event.preventDefault(); event.stopPropagation(); }}
          onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onFavorite(); }}><Star size={15} weight={favorite ? "fill" : "regular"} /></button>}
        {canPreview && asset.kind === "image" && (
          <button
            type="button"
            className="copy-button"
            title="复制完整图片"
            aria-label={`复制图片 ${asset.name}`}
            disabled={copyDisabled}
            draggable={false}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onDragStart={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onCopy(asset);
            }}
          >
            <Copy size={16} />
          </button>
        )}
        {canPreview && (asset.kind === "video" || asset.kind === "audio") && (
          <button
            type="button"
            className="video-outbound-button"
            title={
              asset.kind === "audio"
                ? "下载原音频；到目标网站选择此文件上传。兼容的目标也可尝试拖出"
                : "悬停素材卡片后拖出原视频；不兼容时点击下载，再从下载记录拖入剪辑软件"
            }
            aria-label={`下载或拖出 ${asset.name}`}
            draggable
            onClick={(event) => {
              event.stopPropagation();
              downloadOriginal(asset);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            onDragStart={(event) => {
              event.stopPropagation();
              writeMediaFileDrag(event.dataTransfer, asset);
            }}
          >
            <DownloadSimple size={16} />
          </button>
        )}
        {stackCount > 1 && onHistory && (
          <button
            className="stack-count"
            aria-label={`展开 ${stackCount} 个视频版本`}
            title="展开视频版本"
            onClick={(event) => {
              event.stopPropagation();
              onHistory();
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <Stack size={15} />
            {stackCount}
          </button>
        )}
        {dropHover && (
          <span className="stack-drop-label">松开添加视频版本</span>
        )}
        {canPreview && (
          <button
            className="preview-button"
            title="放大预览 · 空格"
            aria-label={`预览 ${asset.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onPreview();
            }}
          >
            <MagnifyingGlass size={16} />
          </button>
        )}
        {asset.kind === "video" && (
          <span className="type-pill video-type-pill">
            <Play size={10} weight="fill" />
            视频
          </span>
        )}
        {asset.status === "rejected" && (
          <span className="type-pill rejected-pill">已淘汰</span>
        )}
      </div>
      <div
        className="asset-caption"
        aria-hidden={display.names === "hover" ? true : undefined}
      >
        <strong title={asset.name}>{asset.name}</strong>
        <span>{formatSize(asset.size)}</span>
      </div>
    </article>
  );
}
