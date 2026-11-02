import { useState } from "react";
import { MagnifyingGlass, Check, ArrowRight } from "@phosphor-icons/react";
import type { EditParagraph } from "../../types";
import { matchesSearch } from "../../services/workspaceSearch";
import { FeatureDialog } from "../shared";

export function ParagraphNavigator({ paragraphs, onJump, onClose }: {
  paragraphs: EditParagraph[]; onJump: (id: string) => boolean; onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const items = paragraphs.map((paragraph, index) => ({ paragraph, index }))
    .filter(({ paragraph, index }) => matchesSearch(query, String(index + 1).padStart(2, "0"), paragraph.text, ...paragraph.notes.map(note => note.text)));
  return <FeatureDialog title="段落导航" onClose={onClose}>
    <div className="paragraph-navigator">
      <label className="navigator-search"><MagnifyingGlass size={17} aria-hidden="true" /><input autoFocus aria-label="查找段落" placeholder="输入段落编号、正文或批注" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="navigator-results" role="list" aria-label="文稿段落">
        {items.map(({ paragraph, index }) => <div role="listitem" key={paragraph.id}><button onClick={() => {
          if (onJump(paragraph.id)) onClose();
          else setError("请等待正文自动保存，并先提交正在填写的批注。");
        }}>
          <span className="navigator-number">{String(index + 1).padStart(2, "0")}</span>
          <span className="navigator-excerpt"><strong>{paragraph.text.trim().split("\n").find(Boolean) || "空白段落"}</strong><small>{paragraph.links.length ? `${paragraph.links.length} 个素材关联` : "尚未关联素材"}{paragraph.notes.length ? ` · ${paragraph.notes.length} 条批注` : ""}</small></span>
          {paragraph.generated && <Check size={16} aria-label="已完成" className="navigator-done" />}<ArrowRight size={15} aria-hidden="true" />
        </button></div>)}
        {!items.length && <p className="feature-note">没有找到段落，试试其他关键词。</p>}
      </div>
      {error && <p role="alert" className="feature-error">{error}</p>}
    </div>
  </FeatureDialog>;
}
