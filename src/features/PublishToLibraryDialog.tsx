import { useState } from "react";
import type { Asset } from "../types";
import type { FolderConnection } from "../services/folderConnections";
import {
  publishToLibrary,
  libraryGroups,
  type LibraryGroup,
} from "../services/sharedLibrary";
import { FeatureDialog } from "./shared";

export function PublishToLibraryDialog({
  assets,
  connection,
  clientId,
  onClose,
  onPublished,
}: {
  assets: Asset[];
  connection: FolderConnection;
  clientId: string;
  onClose: () => void;
  onPublished: (result: { added: number; duplicates: number }) => Promise<void>;
}) {
  const [group, setGroup] = useState<LibraryGroup | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <FeatureDialog title="收录到公共资产库" busy={busy} onClose={onClose}>
      <form
        className="feature-fields"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            const inputs = [];
            for (const asset of assets) {
              const response = await fetch(asset.url || "");
              if (!response.ok) throw new Error(`无法读取原图：${asset.name}`);
              inputs.push({ asset, blob: await response.blob() });
            }
            const result = await publishToLibrary(
              connection.handle,
              clientId,
              inputs,
              group || undefined,
            );
            await onPublished(result);
          } catch (reason) {
            setError((reason as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          {assets.length} 张图片 → {connection.name}
        </p>
        <label>
          公共库分类
          <select
            value={group}
            disabled={busy}
            onChange={(event) =>
              setGroup(event.target.value as LibraryGroup | "")
            }
          >
            <option value="">沿用素材分类</option>
            {libraryGroups.filter((item) => item.id !== "prop").map((item) => (
              <option value={item.id} key={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <p className="feature-note">
          复制完整图片，不移动项目原片；不公开项目名、脚本、Prompt
          或标签。同内容自动跳过。
        </p>
        {error && (
          <p role="alert" className="feature-error">
            {error}
          </p>
        )}
        <div className="feature-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="feature-primary" disabled={busy}>
            {busy ? "正在校验并保存…" : "确认收录"}
          </button>
        </div>
      </form>
    </FeatureDialog>
  );
}
