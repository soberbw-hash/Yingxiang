import type { Asset } from "../types";
import type { StackAction } from "../../shared/asset-stacks.mjs";
import { stackMembers } from "../../shared/asset-stacks.mjs";
import { useState } from "react";
import { FeatureDialog } from "./shared";
import { AssetCompareDialog } from "./AssetCompareDialog";
import {
  downloadOriginal,
  writeAssetDrag,
  writeVideoFileDrag,
} from "../services/assetOutbound";
import { Check, DownloadSimple, Stack, Play } from "@phosphor-icons/react";
export function AssetStackHistory({
  asset,
  assets,
  onAction,
  onClose,
  onPreview,
}: {
  asset: Asset;
  assets: Asset[];
  onAction: (action: StackAction) => Promise<unknown>;
  onClose: () => void;
  onPreview: (asset: Asset) => void;
}) {
  const members = stackMembers(asset, assets);
  const [compare, setCompare] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const action = async (value: StackAction) => {
    setBusy(true);
    setError("");
    try {
      await onAction(value);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <FeatureDialog
      title={`视频版本 · ${members.length}`}
      onClose={onClose}
      busy={busy}
    >
      {members.length >= 2 && <div className="stack-compare-entry"><button disabled={busy} onClick={() => setCompare(true)}>并排对比版本</button><span>同步播放后，可直接选择置顶版本</span></div>}
      {compare && <AssetCompareDialog assets={members} initialIds={members.slice(0, 2).map(a => a.id)} onClose={() => setCompare(false)} onStackAction={onAction} />}
      <div className="stack-history">
        {members.map((item, index) => (
          <article
            key={item.id}
            data-preview-asset={item.id}
            draggable={!busy}
            onDragStart={(event) => {
              writeAssetDrag(event.dataTransfer, members);
              writeVideoFileDrag(event.dataTransfer, members[0]);
            }}
          >
            <button
              className="stack-history-preview"
              onClick={() => onPreview(item)}
              aria-label={`预览版本 ${item.name}`}
            >
              <video
                src={item.url}
                preload="metadata"
                muted
                onLoadedMetadata={(event) => {
                  event.currentTarget.currentTime = Math.min(
                    0.2,
                    event.currentTarget.duration || 0,
                  );
                }}
              />
              <Play size={20} />
            </button>
            <div className="stack-history-info">
              <strong title={item.name}>{item.name}</strong>
              <span>
                {item.status === "final"
                  ? "最终稿"
                  : index === 0
                    ? "当前置顶"
                    : "历史版本"}
              </span>
              <div>
                <button
                  disabled={busy}
                  aria-pressed={item.status === "final"}
                  onClick={() =>
                    void action({
                      type: "final",
                      id: item.id,
                      value: item.status !== "final",
                    })
                  }
                >
                  <Check size={13} />
                  {item.status === "final" ? "取消最终稿" : "设为最终稿"}
                </button>
                <button
                  disabled={busy}
                  title="移出堆叠，保留素材和原片"
                  onClick={() => void action({ type: "detach", id: item.id })}
                >
                  <Stack size={14} />
                  移出
                </button>
                <button
                  title="下载此版本"
                  aria-label={`下载 ${item.name}`}
                  onClick={() => {
                    try {
                      downloadOriginal(item);
                    } catch (reason) {
                      setError((reason as Error).message);
                    }
                  }}
                >
                  <DownloadSimple size={14} />
                </button>
              </div>
            </div>
          </article>
        ))}
        {error && (
          <p className="feature-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </FeatureDialog>
  );
}
