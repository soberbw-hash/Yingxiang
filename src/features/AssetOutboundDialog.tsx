import { useState } from "react";
import { Copy, DownloadSimple } from "@phosphor-icons/react";
import { type Asset, formatSize } from "../types";
import {
  writeAssetDrag,
  copyAssetImage,
  downloadOriginal,
  writeMediaFileDrag,
} from "../services/assetOutbound";
import { AssetMedia, FeatureDialog, errorText } from "./shared";
import { AudioThumbnail } from "../components/AudioThumbnail";

export function AssetOutboundDialog({
  assets,
  onClose,
}: {
  assets: Asset[];
  onClose: () => void;
}) {
  const [copying, setCopying] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  return (
    <FeatureDialog title="用于上传" onClose={onClose} busy={!!copying}>
      <div className="outbound-content">
        <p className="feature-note">
          直接按住图片本身拖到目标上传区域，不要拖文件名、按钮或卡片边框。外部一次一张；网站不接收时可复制图片后粘贴，或下载原文件再上传。
        </p>
        {assets.some((asset) => asset.kind === "audio") && (
          <p className="feature-note">
            音频会预读原文件供拖出，先停留片刻再拖动缩略图；直接跨网页拖音频不保证被接收。不响应时点“下载原文件”，再到目标网站选择文件上传，或从资源管理器拖入。
          </p>
        )}
        <div className="outbound-list">
          {assets.map((asset) => (
            <div className="outbound-item" key={asset.id}>
              <div
                className="outbound-thumb"
                onDragStart={(event) => {
                  if (
                    (asset.kind === "video" || asset.kind === "audio") &&
                    !copying
                  ) {
                    writeMediaFileDrag(event.dataTransfer, asset);
                    return;
                  }
                  if (
                    (event.target as HTMLElement).tagName !== "IMG" ||
                    !!copying
                  ) {
                    event.preventDefault();
                    return;
                  }
                  writeAssetDrag(event.dataTransfer, [asset]);
                }}
                title={
                  asset.kind === "image"
                    ? "拖动这张图片到目标上传区域"
                    : undefined
                }
                draggable={asset.kind === "video" || asset.kind === "audio"}
              >
                {asset.kind === "audio" ? (
                  <AudioThumbnail asset={asset} />
                ) : (
                  <AssetMedia asset={asset} />
                )}
              </div>
              <div className="outbound-meta">
                <strong title={asset.name}>{asset.name}</strong>
                <span>{formatSize(asset.size)} · 原文件</span>
              </div>
              <div className="feature-actions">
                {asset.kind === "image" && (
                  <button
                    type="button"
                    disabled={!!copying}
                    onClick={() => {
                      setCopying(asset.id);
                      setError("");
                      setFeedback("");
                      try {
                        void copyAssetImage(asset)
                          .then(() =>
                            setFeedback(
                              "已复制完整图片（PNG）。请到支持图片粘贴的上传区域按 Ctrl + V；这不代表已上传。",
                            ),
                          )
                          .catch((reason) =>
                            setError(
                              `${errorText(reason)} 也可以下载原文件上传。`,
                            ),
                          )
                          .finally(() => setCopying(""));
                      } catch (reason) {
                        setError(errorText(reason));
                        setCopying("");
                      }
                    }}
                  >
                    <Copy />
                    {copying === asset.id ? "正在复制…" : "复制图片"}
                  </button>
                )}
                <button
                  type="button"
                  disabled={!!copying}
                  onClick={() => {
                    setError("");
                    try {
                      downloadOriginal(asset);
                      setFeedback(
                        "已请求浏览器下载原文件。请在下载列表确认保存，再拖到目标页面或通过文件选择器上传。",
                      );
                    } catch (reason) {
                      setError(errorText(reason));
                    }
                  }}
                >
                  <DownloadSimple />
                  下载原文件
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="feature-note">
          图片使用浏览器原生拖放，不代表目标网站已接收。多选只用于映箱
          内部整理；视频拖出使用 Chrome
          的兼容方式（音频也沿用此方式），网站或剪辑软件不接收时请下载原文件，从文件选择器上传，或从下载记录/资源管理器拖入。复制图片保留完整画面，非
          PNG 转成 PNG，动态图仅复制静态帧。不会自动向外站发送素材。
        </p>
        {error && (
          <p role="alert" className="feature-error">
            {error}
          </p>
        )}
        {feedback && (
          <p role="status" className="feature-note">
            {feedback}
          </p>
        )}
      </div>
    </FeatureDialog>
  );
}
