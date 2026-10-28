import { Star, Play, DotsThree, Stack } from "@phosphor-icons/react";
import type { Asset, EditLink } from "../../types";
import { useState } from "react";
import { assetCategoryStyle } from "../../services/assetCategoryTheme";
import {
  prepareAudioDragFile,
  prepareVideoDragFile,
  startNativeAssetDrag,
  writeAssetDrag,
  writeMediaFileDrag,
  downloadOriginal,
} from "../../services/assetOutbound";
import { AssetStackHistory } from "../AssetStackHistory";
import type { StackAction } from "../../../shared/asset-stacks.mjs";
import { AudioThumbnail } from "../../components/AudioThumbnail";

export function ReferenceMedia({
  asset,
  projectId,
  link,
  busy,
  onPrimary,
  onUnlink,
  onPreview,
  members = [asset],
  onVersionPreview,
  onStackAction,
  onReorder,
}: {
  asset: Asset;
  projectId: string;
  link: EditLink;
  busy: boolean;
  onPrimary: () => void;
  onUnlink: () => void;
  onPreview: () => void;
  members?: Asset[];
  onVersionPreview: (asset: Asset) => void;
  onStackAction: (action: StackAction) => Promise<unknown>;
  onReorder: (sourceAssetId: string, targetAssetId: string) => void;
}) {
  const [history, setHistory] = useState(false),
    [error, setError] = useState("");
  return (
    <article
      className={`reference-media reference-compact ${asset.kind === "video" ? "reference-video" : ""} ${asset.kind !== "video" && link.role === "primary" ? "is-primary" : ""}`}
      style={assetCategoryStyle(asset.category)}
      data-preview-asset={asset.id}
      data-kind={asset.kind}
      draggable={!busy}
      onPointerEnter={() => {
        if (asset.kind === "audio") void prepareAudioDragFile(asset).catch(() => {});
        if (asset.kind === "video") void prepareVideoDragFile(asset).catch(() => {});
      }}
      onDragStart={(event) => {
        // The parent paragraph handles text dragging and otherwise cancels dragstart.
        // Keep media drags from reaching that handler.
        event.stopPropagation();
        if (startNativeAssetDrag(event, projectId, asset.id)) return;
        if (asset.kind !== "image") {
          const thumb = event.currentTarget.querySelector<HTMLElement>(".reference-thumb");
          if (thumb) {
            const bounds = thumb.getBoundingClientRect();
            event.dataTransfer.setDragImage(thumb, Math.min(24, bounds.width / 2), Math.min(24, bounds.height / 2));
          }
        }
        writeAssetDrag(event.dataTransfer, members);
        writeMediaFileDrag(event.dataTransfer, members[0]);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("application/weave-assets")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(event) => {
        const raw = event.dataTransfer.getData("application/weave-assets");
        if (!raw) return;
        event.preventDefault();
        event.stopPropagation();
        try {
          const ids: unknown = JSON.parse(raw);
          if (Array.isArray(ids) && typeof ids[0] === "string") onReorder(ids[0], asset.id);
        } catch { /* ignore unrelated browser drags */ }
      }}
    >
      {history && (
        <AssetStackHistory
          asset={asset}
          assets={members}
          onClose={() => setHistory(false)}
          onAction={onStackAction}
          onPreview={onVersionPreview}
        />
      )}
      <button
        className="reference-thumb"
        onClick={onPreview}
        aria-label={`预览 ${asset.name}`}
        title="空格快速预览"
      >
        {asset.kind === "image" ? (
          <img src={asset.url} alt={asset.name} loading="lazy" draggable />
        ) : asset.kind === "video" ? (
          <>
            <video
              src={asset.url}
              preload="metadata"
              muted
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                video.currentTime = Math.min(0.2, video.duration / 2);
              }}
              onError={() => setError("无法预览，可下载原片")}
            />
            <Play className="reference-play" size={24} weight="fill" />
          </>
        ) : (
          <AudioThumbnail asset={asset} />
        )}
        <span className="reference-hover-name">{asset.name}</span>
      </button>
      {members.length > 1 && (
        <button
          className="reference-stack-count"
          title="展开全部视频版本"
          aria-label={`展开 ${members.length} 个视频版本`}
          onClick={() => setHistory(true)}
        >
          <Stack size={13} />
          {members.length}
        </button>
      )}
      <div className="reference-media-actions">
        {asset.kind !== "video" && <button
          className={link.role === "primary" ? "primary-label" : ""}
          aria-pressed={link.role === "primary"}
          title={link.role === "primary" ? "取消本段主选。此状态只影响当前段落。" : "设为本段主选。此状态只影响当前段落。"}
          onClick={onPrimary}
          disabled={busy}
        >
          <Star weight={link.role === "primary" ? "fill" : "regular"} size={13} />
          {link.role === "primary" ? "主选" : "备选"}
        </button>}
        <details className="reference-menu">
          <summary aria-label={`素材操作 ${asset.name}`} title="素材操作">
            <DotsThree size={18} />
          </summary>
          <div>
            <button onClick={onPreview}>放大预览</button>
            <button
              onClick={() => {
                try {
                  downloadOriginal(members[0]);
                } catch (reason) {
                  setError((reason as Error).message);
                }
              }}
            >
              下载当前版本
            </button>
            <button disabled={busy} onClick={onUnlink}>
              解除关联
            </button>
          </div>
        </details>
      </div>
      {error && (
        <p role="alert" className="editing-muted">
          {error}
        </p>
      )}
    </article>
  );
}
