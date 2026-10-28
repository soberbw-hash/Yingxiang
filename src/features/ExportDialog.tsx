import { useState, type CSSProperties } from "react";
import { Download } from "@phosphor-icons/react";
import type { ExportInclude, ProjectSnapshot } from "../types";
import { getStoryboardEntries } from "../services/storyboard";
import { projectLabel } from "../../shared/workspace-labels.mjs";
import { AssetMedia, FeatureDialog, errorText } from "./shared";
import "./features.css";

export type ExportOptions = {
  include: ExportInclude;
  format: "zip" | "folder";
  layout: number;
  labels: boolean;
  fit: "contain" | "cover";
};
export type ExportDialogProps = {
  snapshot: ProjectSnapshot;
  canExportFolder?: boolean;
  onClose: () => void;
  onExport: (options: ExportOptions) => Promise<void>;
  onBackup?: (includeTrash: boolean) => Promise<void>;
};
const includeLabels: { key: keyof ExportInclude; label: string }[] = [
  { key: "assets", label: "素材清单与元数据" },
  { key: "originals", label: "素材原文件" },
  { key: "storyboard", label: "分镜板" },
  { key: "scripts", label: "脚本与剪辑文稿" },
  { key: "videos", label: "视频文件" },
];
export function ExportDialog({
  snapshot,
  canExportFolder = true,
  onClose,
  onExport,
  onBackup,
}: ExportDialogProps) {
  const entries = getStoryboardEntries(snapshot);
  const [includeTrash, setIncludeTrash] = useState(true);
  const trashCount = snapshot.assets.filter(asset => asset.trashedAt).length;
  const backupAssets = snapshot.assets.filter(asset => includeTrash || !asset.trashedAt);
  const backupBytes = backupAssets.reduce((sum, asset) => sum + asset.size, 0);
  const browserBackupTooLarge = !canExportFolder && backupBytes >= 512 * 1024 * 1024;
  const [purpose, setPurpose] = useState<"backup" | "delivery">(onBackup ? "backup" : "delivery");
  const [include, setInclude] = useState<ExportInclude>(() => ({
    assets: true,
    originals: true,
    storyboard: entries.length > 0,
    scripts: true,
    videos: true,
  }));
  const [format, setFormat] = useState<"zip" | "folder">("zip");
  const [layout, setLayout] = useState(3);
  const [labels, setLabels] = useState(true);
  const [fit, setFit] = useState<"contain" | "cover">("contain");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <FeatureDialog title="备份与导出" onClose={onClose} wide busy={busy} className={`export-dialog purpose-${purpose}`}>
      <form
        className="feature-export-layout"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            if (purpose === "backup" && onBackup) await onBackup(includeTrash);
            else await onExport({ include, format, layout, labels, fit });
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset className="feature-fields" disabled={busy}>
          <legend>{projectLabel(snapshot.project)}</legend>
          {onBackup && <div className="export-purpose" role="group" aria-label="导出用途">
            <button type="button" aria-pressed={purpose === "backup"} onClick={() => setPurpose("backup")}>完整备份</button>
            <button type="button" aria-pressed={purpose === "delivery"} onClick={() => setPurpose("delivery")}>交付导出</button>
          </div>}
          {purpose === "backup" ? <>
            <h3>保留整个项目，方便以后恢复</h3>
            <p className="feature-note">包含素材原片、文稿与批注、文稿历史、旧镜头和画布。可能包含私人提示词，请妥善保管。</p>
            <label className="feature-check"><input type="checkbox" checked={includeTrash} onChange={event => setIncludeTrash(event.target.checked)} />备份回收站（{trashCount} 个素材）</label>
            {!includeTrash && <p className="feature-note">此备份不含回收站素材及其关联，恢复后无法从该备份找回这些素材；当前项目不会被删除。</p>}
            <p>{backupAssets.length} 个原片 · {includeTrash ? trashCount : 0} 个回收站素材 · {snapshot.editing?.paragraphs.length || 0} 段文稿 · {snapshot.editingHistory?.length || 0} 个历史版本</p>
            <p className="feature-note">生成前会检查原片；浏览器 ZIP 还会用恢复入口回读校验。下载后请确认文件已保存。</p>
            {!canExportFolder && <p className={browserBackupTooLarge ? "feature-error" : "feature-note"}>{browserBackupTooLarge ? "原片已超过浏览器 ZIP 恢复的 512 MB 上限；请在设置中另存到本地文件夹，并备份整个项目文件夹。" : "浏览器 ZIP 恢复上限为 512 MB；较大的项目请另存并备份整个项目文件夹。"}</p>}
          </> : <>
          <h3>导出内容</h3>
          <p className="feature-note">只包含下面勾选的内容，适合交付；完整恢复请使用“完整备份”。</p>
          {includeLabels.map((item) => (
            <label className="feature-check" key={item.key}>
              <input
                type="checkbox"
                checked={include[item.key]}
                onChange={(event) =>
                  setInclude((value) => ({
                    ...value,
                    [item.key]: event.target.checked,
                  }))
                }
              />
              {item.label}
            </label>
          ))}
          <label>
            格式
            <select
              value={format}
              onChange={(event) =>
                setFormat(event.target.value as "zip" | "folder")
              }
            >
              <option value="zip">ZIP 压缩包</option>
              {canExportFolder && <option value="folder">文件夹</option>}
            </select>
          </label>
          <fieldset className="feature-fields" disabled={!include.storyboard}>
            <legend>分镜板布局</legend>
            <label>
              每行镜头数
              <select
                value={layout}
                onChange={(event) => setLayout(Number(event.target.value))}
              >
                {[2, 3, 4].map((value) => (
                  <option value={value} key={value}>
                    {value} 列
                  </option>
                ))}
              </select>
            </label>
            <label className="feature-check">
              <input
                type="checkbox"
                checked={labels}
                onChange={(event) => setLabels(event.target.checked)}
              />
              显示镜头标题
            </label>
            <label>
              画面适配
              <select
                value={fit}
                onChange={(event) =>
                  setFit(event.target.value as "contain" | "cover")
                }
              >
                <option value="contain">完整显示</option>
                <option value="cover">填充并裁切</option>
              </select>
            </label>
          </fieldset>
          </>}
          {error && (
            <p role="alert" className="feature-error">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="feature-primary"
            disabled={busy || purpose === "backup" && browserBackupTooLarge || purpose === "delivery" && !Object.values(include).some(Boolean)}
          >
            <Download />
            {busy ? "正在校验并生成…" : purpose === "backup" ? includeTrash ? "创建完整备份" : "创建备份（不含回收站）" : "导出交付包"}
          </button>
        </fieldset>
        <div className="feature-export-preview">
          {purpose === "backup" ? <div className="backup-explainer"><h3>以后如何恢复</h3><ol><li>保存备份 ZIP；桌面版备份保存在项目旁的备份区。</li><li>浏览器在“全部项目 → 恢复备份”选择 ZIP；桌面版在设置中恢复备份。</li><li>核对素材和文稿数量，再恢复为独立副本。</li></ol><p>现有项目会保留，可以对照检查后再继续制作。</p></div> : <>
          <h3>分镜板预览</h3>
          {include.storyboard ? (
            entries.length ? (
              <div
                className="feature-board-grid"
                style={
                  {
                    "--feature-columns": layout,
                    "--feature-fit": fit,
                  } as CSSProperties
                }
              >
                {entries.map((entry, index) => (
                  <figure key={`${entry.asset.id}-${index}`}>
                    <div className="feature-board-media">
                      <AssetMedia asset={entry.asset} />
                    </div>
                    {labels && (
                      <figcaption>
                        {String(index + 1).padStart(2, "0")} · {entry.title}
                      </figcaption>
                    )}
                  </figure>
                ))}
              </div>
            ) : (
              <p className="feature-empty">
                请先为镜头关联图片，或把图片归入「分镜」
              </p>
            )
          ) : (
            <p className="feature-empty">未选择导出分镜板</p>
          )}
          </>}
        </div>
      </form>
    </FeatureDialog>
  );
}
