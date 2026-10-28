import { useState } from "react";
import type { Asset, EditDocument, EditingVersion } from "../../types";
import { FeatureDialog } from "../shared";

export function DocumentHistory({ current, versions, assets, busy, error, onRestore, onClose }: {
  current: EditDocument; versions: EditingVersion[]; assets: Asset[]; busy: boolean; error: string;
  onRestore: (version: EditingVersion) => Promise<boolean>; onClose: () => void;
}) {
  const [selected, setSelected] = useState(versions[versions.length - 1]?.id || "");
  const version = versions.find(item => item.id === selected);
  const ids = new Set(assets.map(asset => asset.id));
  const missing = version?.document.paragraphs.flatMap(p => p.links).filter(link => !ids.has(link.assetId)).length || 0;
  const text = (doc: EditDocument, other: EditDocument) => <div className="history-document">{doc.paragraphs.map(p => <p key={p.id} className={other.paragraphs.some(x => x.id === p.id && x.text === p.text) ? "" : "history-changed"}>{p.text || "（空段落）"}</p>)}</div>;
  return <FeatureDialog title="文稿历史" onClose={onClose} wide busy={busy}>
    <div className="document-history">
      <p className="feature-note">最多保留 40 个阶段；连续输入会合并，较大文稿按空间保留最近版本。历史随完整备份保存，高亮表示不同的段落。</p>
      {!versions.length ? <p className="feature-empty">还没有历史版本。下一次修改会自动保留当前文稿。</p> : <>
        <label>查看版本<select aria-label="选择文稿历史版本" value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}>{[...versions].reverse().map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.label}前 · {item.document.paragraphs.length} 段</option>)}</select></label>
        {version && <>
          <div className="history-comparison"><section><h3>历史版本 · {version.document.title}</h3>{text(version.document, current)}</section><section><h3>当前版本 · {current.title}</h3>{text(current, version.document)}</section></div>
          {!!missing && <p className="feature-error" role="alert">该版本有 {missing} 条素材关联已不在项目中，请先找回对应素材再完整恢复。正文仍可选择复制。</p>}
          <div className="feature-actions"><button disabled={busy} onClick={onClose}>返回当前文稿</button><button className="feature-primary" disabled={busy || !!missing} onClick={async () => { if (await onRestore(version)) onClose(); }}>{busy ? "正在恢复…" : "恢复这个版本"}</button></div>
          <p className="feature-note">恢复前也会保留当前版本；恢复操作支持 Ctrl+Z。</p>
        </>}
      </>}
      {error && <p className="feature-error" role="alert">{error}</p>}
    </div>
  </FeatureDialog>;
}
