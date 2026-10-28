import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  ChatCircleText,
  Check,
  Plus,
  Trash,
  Scissors,
  LinkBreak,
  CopySimple,
  DotsSixVertical,
} from "@phosphor-icons/react";
import type { Asset, EditAction, EditParagraph } from "../../types";
import { ReferenceMedia } from "./ReferenceMedia";
import { bindDragCleanup } from "../../services/dragLifecycle";
import {
  groupAssets,
  type StackAction,
} from "../../../shared/asset-stacks.mjs";

function getTextCaret(element: HTMLTextAreaElement) {
  return element.selectionStart;
}

function textOffsetAtPoint(element: HTMLElement, x: number, y: number) {
  const pointDocument = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => {
      offsetNode: Node;
      offset: number;
    } | null;
  };
  const range = document.caretRangeFromPoint?.(x, y);
  if (range && element.contains(range.startContainer)) {
    const prefix = range.cloneRange();
    prefix.selectNodeContents(element);
    prefix.setEnd(range.startContainer, range.startOffset);
    return prefix.toString().length;
  }
  const position = pointDocument.caretPositionFromPoint?.(x, y);
  if (!position || !element.contains(position.offsetNode)) return undefined;
  const prefix = document.createRange();
  prefix.selectNodeContents(element);
  prefix.setEnd(position.offsetNode, position.offset);
  return prefix.toString().length;
}

function getSelectionOffsets(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return undefined;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return undefined;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(element);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  return { start, end: start + range.toString().length };
}

function selectedTextRects(textarea: HTMLTextAreaElement, start: number, end: number) {
  const rect = textarea.getBoundingClientRect(), style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const property of ["box-sizing", "font", "font-size", "font-family", "font-weight", "font-style", "letter-spacing", "line-height", "text-indent", "text-transform", "padding", "border", "word-spacing", "tab-size", "overflow-wrap", "word-break"])
    mirror.style.setProperty(property, style.getPropertyValue(property));
  Object.assign(mirror.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, whiteSpace: "pre-wrap", overflow: "hidden", visibility: "hidden", pointerEvents: "none", zIndex: "-1" });
  const before = document.createElement("span");
  before.textContent = textarea.value.slice(0, start);
  mirror.append(before);
  const selection = document.createElement("span");
  selection.textContent = textarea.value.slice(start, end);
  const after = document.createElement("span");
  after.textContent = textarea.value.slice(end);
  mirror.append(selection, after);
  document.body.appendChild(mirror);
  mirror.scrollTop = textarea.scrollTop;
  mirror.scrollLeft = textarea.scrollLeft;
  const rectsOf = (element: HTMLElement) => Array.from(element.getClientRects()).filter(item => item.width && item.height).map(item => ({ left: item.left, right: item.right, top: item.top, bottom: item.bottom }));
  const rects = rectsOf(selection), occupied = [...rectsOf(before), ...rects, ...rectsOf(after)];
  mirror.remove();
  return { rects, occupied };
}

export function ParagraphCard({
  paragraph: p,
  projectId,
  index,
  total,
  assets,
  busy,
  onTextDraftChange,
  primaryOnly,
  mergeSelected,
  onToggleMerge,
  onStageSelection,
  onReorder,
  active,
  workspaceActive,
  onAction,
  onDropFiles,
  onChoose,
  onPreview,
  onStackAction,
}: {
  paragraph: EditParagraph;
  projectId: string;
  index: number;
  total: number;
  assets: Asset[];
  busy: boolean;
  onTextDraftChange: (id: string, text: string | null) => void;
  primaryOnly: boolean;
  mergeSelected: boolean;
  onToggleMerge: (extend: boolean) => void;
  onStageSelection: (selection: { id: string; start: number; end: number; quote: string }) => void;
  onReorder: (sourceId: string, index: number) => Promise<boolean>;
  active: boolean;
  workspaceActive: boolean;
  onAction: (action: EditAction) => Promise<boolean>;
  onDropFiles: (files: File[]) => Promise<void>;
  onChoose: () => void;
  onPreview: (asset: Asset) => void;
  onStackAction: (action: StackAction) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(p.text),
    [notes, setNotes] = useState(false),
    [note, setNote] = useState("");
  const [selected, setSelected] = useState<{
    start: number;
    end: number;
    quote: string;
  }>();
  const [selectionPosition, setSelectionPosition] = useState<{ left: number; top: number }>();
  const selectionToolbar = useRef<HTMLDivElement>(null);
  const [dropping, setDropping] = useState(false);
  const [reordering, setReordering] = useState<"before" | "after" | null>(null);
  const [draggingParagraph, setDraggingParagraph] = useState(false);
  useEffect(
    () => bindDragCleanup(window, () => { setDropping(false); setReordering(null); setDraggingParagraph(false); }),
    [],
  );
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "pending" | "saving" | "error">("idle");
  const [retrySave, setRetrySave] = useState(0);
  const splitAt = useRef(0);
  const splitPointerAt = useRef<number | undefined>(undefined);
  const textRef = useRef<HTMLDivElement>(null),
    editRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!selected || !workspaceActive) { setSelectionPosition(undefined); return; }
    const update = () => {
      const field = editing ? editRef.current : textRef.current;
      const toolbar = selectionToolbar.current;
      if (!field || !toolbar) return;
      let rects: { left: number; right: number; top: number; bottom: number }[] = [];
      let occupied: typeof rects = [];
      if (field instanceof HTMLTextAreaElement) ({ rects, occupied } = selectedTextRects(field, selected.start, selected.end));
      else {
        const selection = window.getSelection();
        if (selection?.rangeCount && field.contains(selection.getRangeAt(0).startContainer) && field.contains(selection.getRangeAt(0).endContainer)) {
          const range = selection.getRangeAt(0);
          rects = Array.from(range.getClientRects()).filter(r => r.width && r.height);
          const before = range.cloneRange(), after = range.cloneRange();
          before.selectNodeContents(field); before.setEnd(range.startContainer, range.startOffset);
          after.selectNodeContents(field); after.setStart(range.endContainer, range.endOffset);
          occupied = [...Array.from(before.getClientRects()), ...rects, ...Array.from(after.getClientRects())].filter(r => r.right > r.left && r.bottom > r.top);
        }
      }
      const scroll = field.closest(".editing-scroll")?.getBoundingClientRect();
      const bottomLimit = Math.min(window.innerHeight, scroll?.bottom ?? window.innerHeight) - 8;
      const topLimit = Math.max(0, scroll?.top ?? 0) + 8;
      const last = rects[rects.length - 1];
      if (!last || last.bottom < topLimit || last.top > bottomLimit) { setSelectionPosition(undefined); return; }
      const height = toolbar.offsetHeight, width = toolbar.offsetWidth;
      const left = Math.max(8, Math.min(last.left, window.innerWidth - width - 8));
      const firstTop = Math.min(...rects.map(r => r.top));
      const fieldBounds = field.getBoundingClientRect();
      const candidates = [
        { left, top: last.bottom + 8 },
        { left, top: firstTop - height - 8 },
        { left: fieldBounds.right + 8, top: last.bottom + 8 },
        { left: fieldBounds.left - width - 8, top: last.bottom + 8 },
        { left, top: fieldBounds.bottom + 8 },
        { left, top: fieldBounds.top - height - 8 },
      ];
      const position = candidates.find(candidate => candidate.left >= 8 && candidate.left + width <= window.innerWidth - 8 && candidate.top >= topLimit && candidate.top + height <= bottomLimit && !occupied.some(r => candidate.left < r.right && candidate.left + width > r.left && candidate.top < r.bottom && candidate.top + height > r.top));
      setSelectionPosition(position);
    };
    update();
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => { document.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [selected, editing, draft, workspaceActive]);
  useEffect(() => {
    if (!selected || !workspaceActive) return;
    const dismissStaleSelection = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (textRef.current?.contains(target) || editRef.current?.contains(target) || selectionToolbar.current?.contains(target)) return;
      setSelected(undefined);
    };
    document.addEventListener("pointerdown", dismissStaleSelection, true);
    return () => document.removeEventListener("pointerdown", dismissStaleSelection, true);
  }, [selected, workspaceActive]);
  const previousText = useRef(p.text),
    saveAttempt = useRef(0),
    onActionRef = useRef(onAction),
    autoSaveTimer = useRef<number | undefined>(undefined);
  onActionRef.current = onAction;
  useEffect(() => () => onTextDraftChange(p.id, null), [onTextDraftChange, p.id]);
  const dirty = (editing && draft !== p.text) || !!note.trim();
  useEffect(() => {
    const field = editRef.current;
    if (field && field.selectionEnd > field.selectionStart) {
      const start = field.selectionStart, end = field.selectionEnd;
      setSelected({ start, end, quote: field.value.slice(start, end) });
    } else setSelected(undefined);
  }, [p.text]);
  useLayoutEffect(() => {
    const editable = editRef.current;
    if (editing && editable) {
      if (
        editable.value !== p.text &&
        (draft === p.text || draft === previousText.current)
      )
        setDraft(p.text);
      editable.style.height = "auto";
      editable.style.height = `${Math.max(56, editable.scrollHeight)}px`;
    }
    previousText.current = p.text;
  }, [draft, editing, p.text]);
  const saveTextRef = useRef<() => Promise<boolean>>(async () => true);
  saveTextRef.current = async () => {
    const text = (editRef.current?.value ?? draft).replace(/\r\n/g, "\n");
    if (text === p.text) {
      setSaveState("idle");
      return true;
    }
    const attempt = ++saveAttempt.current;
    setSaveState("saving");
    const saved = await onActionRef.current({ type: "text", id: p.id, text });
    const latest = editRef.current?.value ?? draft;
    if (saved) onTextDraftChange(p.id, latest === text ? null : latest);
    if (attempt === saveAttempt.current) setSaveState(saved ? latest === text ? "idle" : "pending" : "error");
    return saved;
  };
  useEffect(() => {
    if (!editing || draft === p.text) {
      if (draft === p.text && saveState !== "idle") setSaveState("idle");
      return;
    }
    setSaveState("pending");
    const timer = window.setTimeout(() => {
      autoSaveTimer.current = undefined;
      void saveTextRef.current();
    }, 600);
    autoSaveTimer.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (autoSaveTimer.current === timer) autoSaveTimer.current = undefined;
    };
  }, [draft, editing, p.text, retrySave]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  const available = new Map(
    assets
      .filter((asset) => !asset.trashedAt)
      .map((asset) => [asset.id, asset]),
  );
  const links = [...p.links].sort(
    (a, b) => Number(b.role === "primary") - Number(a.role === "primary"),
  );
  const visible = links.filter(
    (link) =>
      available.has(link.assetId) && (!primaryOnly || link.role === "primary"),
  );
  const action = (value: EditAction) => onAction({ ...value, id: p.id });
  const rememberSplitCaret = (textarea: HTMLTextAreaElement) => {
    splitAt.current = textarea.selectionStart;
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    setSelected(end > start ? { start, end, quote: textarea.value.slice(start, end) } : undefined);
  };
  const enterEditingAt = (position = splitAt.current) => {
    setDraft(p.text);
    setEditing(true);
    requestAnimationFrame(() => {
      const textarea = editRef.current;
      if (!textarea) return;
      const caret = Math.max(0, Math.min(position, textarea.value.length));
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
      textarea.style.height = "auto";
      textarea.style.height = `${Math.max(56, textarea.scrollHeight)}px`;
    });
  };
  const groups = groupAssets(
    visible.map((link) => available.get(link.assetId)!),
    assets.filter(
      (asset) =>
        !asset.trashedAt && p.links.some((link) => link.assetId === asset.id),
    ),
  );
  const reorderGroups = (sourceId: string, targetId: string) => {
    const from = groups.findIndex(group => group.members.some(item => item.id === sourceId));
    const to = groups.findIndex(group => group.members.some(item => item.id === targetId));
    if (from < 0 || to < 0 || from === to) return;
    const reordered = [...groups], [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    const ids = reordered.flatMap(group => group.members.map(item => item.id).filter(id => p.links.some(link => link.assetId === id)));
    for (const link of p.links) if (!ids.includes(link.assetId)) ids.push(link.assetId);
    void action({ type: "reorderLinks", assetIds: ids });
  };
  const selectText = () => {
    if (!textRef.current) return;
    const offsets = getSelectionOffsets(textRef.current);
    if (!offsets) {
      setSelected(undefined);
      return;
    }
    setSelected({ ...offsets, quote: p.text.slice(offsets.start, offsets.end) });
  };
  return (
    <article
      className={`editing-paragraph ${p.generated ? "is-generated" : ""} ${dropping ? "is-dropping" : ""} ${reordering ? `is-reordering-${reordering}` : ""} ${draggingParagraph ? "is-dragging-paragraph" : ""} ${mergeSelected ? "is-merge-selected" : ""} ${active ? "is-active" : ""}`}
      data-paragraph-id={p.id}
      data-editing-dirty={dirty ? "true" : undefined}
      data-note-dirty={note.trim() ? "true" : undefined}
      data-save-state={saveState}
      onDragStart={(event) => {
        const target = event.target as Element;
        if (target.closest(".paragraph-reorder-handle")) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/weave-paragraph", p.id);
          setDraggingParagraph(true);
          return;
        }
        const textElement = target.closest(".paragraph-text");
        const offsets = textElement && getSelectionOffsets(textElement as HTMLElement);
        if (!offsets) {
          event.preventDefault();
          return;
        }
        const quote = p.text.slice(offsets.start, offsets.end);
        if (!quote || quote !== window.getSelection()?.toString()) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/weave-text-selection", JSON.stringify({
          id: p.id,
          ...offsets,
          quote,
        }));
        event.dataTransfer.setData("text/plain", quote);
      }}
      onDragEnd={() => { setReordering(null); setDraggingParagraph(false); }}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("application/weave-paragraph")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const rect = event.currentTarget.getBoundingClientRect();
          setReordering(event.clientY > rect.top + rect.height / 2 ? "after" : "before");
          return;
        }
        if (event.dataTransfer.types.includes("application/weave-text-selection")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDropping(true);
          return;
        }
        if (
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
        if (event.dataTransfer.types.includes("application/weave-paragraph")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const rect = event.currentTarget.getBoundingClientRect();
          setReordering(event.clientY > rect.top + rect.height / 2 ? "after" : "before");
          const scroll = event.currentTarget.closest(".editing-scroll");
          if (scroll) {
            const bounds = scroll.getBoundingClientRect();
            if (event.clientY < bounds.top + 70) scroll.scrollBy(0, -18);
            else if (event.clientY > bounds.bottom - 70) scroll.scrollBy(0, 18);
          }
          return;
        }
        if (event.dataTransfer.types.includes("application/weave-text-selection")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDropping(true);
          return;
        }
        if (
          event.dataTransfer.types.some(
            (type) => type === "Files" || type === "application/weave-assets",
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
          setDropping(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setDropping(false);
          setReordering(null);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDropping(false);
        setReordering(null);
        if (busy) return;
        const selectionRaw = event.dataTransfer.getData("application/weave-text-selection");
        if (selectionRaw) {
          try {
            const selection: unknown = JSON.parse(selectionRaw);
            if (selection && typeof selection === "object" &&
              typeof (selection as { id?: unknown }).id === "string" &&
              Number.isInteger((selection as { start?: unknown }).start) &&
              Number.isInteger((selection as { end?: unknown }).end) &&
              typeof (selection as { quote?: unknown }).quote === "string")
              onStageSelection(selection as { id: string; start: number; end: number; quote: string });
          } catch { /* unrelated or malformed text drag */ }
          return;
        }
        const paragraphId = event.dataTransfer.getData("application/weave-paragraph");
        if (paragraphId) {
          if (paragraphId !== p.id) {
            const sourceIndex = Number(event.dataTransfer.getData("application/weave-paragraph-index"));
            const rect = event.currentTarget.getBoundingClientRect();
            const targetIndex = index + (event.clientY > rect.top + rect.height / 2 ? 1 : 0);
            const finalIndex = targetIndex - (Number.isInteger(sourceIndex) && sourceIndex < targetIndex ? 1 : 0);
            if (Number.isInteger(sourceIndex) && sourceIndex !== finalIndex)
              void onReorder(paragraphId, finalIndex);
          }
          return;
        }
        const raw = event.dataTransfer.getData("application/weave-assets");
        if (raw) {
          try {
            const ids: unknown = JSON.parse(raw);
            if (Array.isArray(ids) && ids.every((id) => typeof id === "string"))
              void action({ type: "link", assetIds: ids });
          } catch {
            /* other app's invalid payload */
          }
        } else if (event.dataTransfer.files.length)
          void onDropFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="paragraph-copy">
        <header className="paragraph-header">
          <span className="paragraph-drag-slot">
            <span
              className="paragraph-reorder-handle"
              draggable={!busy}
              role="button"
              tabIndex={0}
              aria-label={`拖动第 ${index + 1} 段排序`}
              title="拖动此处调整段落顺序"
              onDragStart={(event) => event.dataTransfer.setData("application/weave-paragraph-index", String(index))}
              onKeyDown={(event) => {
                if (event.key === "ArrowUp" && index > 0) {
                  event.preventDefault();
                  void action({ type: "move", direction: -1 });
                } else if (event.key === "ArrowDown" && index < total - 1) {
                  event.preventDefault();
                  void action({ type: "move", direction: 1 });
                }
              }}
            ><DotsSixVertical size={14} /></span>
            <button type="button" className={`paragraph-number ${mergeSelected ? "is-selected" : ""}`} aria-pressed={mergeSelected} title="点击选择；继续点击相邻段落可扩展，按住 Shift 可选范围" onClick={(event) => onToggleMerge(event.shiftKey)}>
              {String(index + 1).padStart(2, "0")}
            </button>
          </span>
          <button
            className={`paragraph-status ${p.generated ? "done" : ""}`}
            disabled={busy}
            aria-pressed={p.generated}
            onClick={() =>
              void action({ type: "generated", value: !p.generated })
            }
          >
            <Check size={12} />
            {p.generated ? "已完成" : "标记完成"}
          </button>
          {saveState !== "idle" && (
            <span
              className={`paragraph-autosave ${saveState === "error" ? "is-error" : ""}`}
              role="status"
              aria-live="polite"
            >
              {saveState === "error" ? (
                <button onClick={() => setRetrySave((value) => value + 1)}>
                  自动保存失败 · 重试
                </button>
              ) : saveState === "saving" ? "正在自动保存…" : "等待自动保存…"}
            </span>
          )}
          <div className="paragraph-tools">
            <button
              title="上移一段"
              aria-label={`上移第 ${index + 1} 段`}
              disabled={busy || !index}
              onClick={() => void action({ type: "move", direction: -1 })}
            ><ArrowUp size={15} /></button>
            <button
              title="下移一段"
              aria-label={`下移第 ${index + 1} 段`}
              disabled={busy || index === total - 1}
              onClick={() => void action({ type: "move", direction: 1 })}
            ><ArrowDown size={15} /></button>
            <button
              title={copied ? "已复制正文" : copyFailed ? "复制失败：浏览器未授予剪贴板权限" : "复制正文"}
              aria-label={`复制第 ${index + 1} 段正文`}
              disabled={!p.text}
              onClick={async () => {
                setCopied(false);
                setCopyFailed(false);
                try {
                  await navigator.clipboard.writeText(p.text);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1400);
                } catch {
                  setCopyFailed(true);
                }
              }}
            >
              {copied ? <Check size={15} /> : <CopySimple size={15} />}
            </button>
            {(copied || copyFailed) && (
              <span
                className={`paragraph-copy-feedback ${copyFailed ? "is-error" : ""}`}
                role="status"
                aria-live="polite"
              >
                {copied ? "已复制" : "复制失败"}
              </span>
            )}
            <button
              title={editing ? "从当前光标位置拆段（文字会先自动保存）" : "点正文进入编辑，再从光标位置拆段"}
              aria-label={editing ? `从光标拆分第 ${index + 1} 段` : `从指定位置拆分第 ${index + 1} 段`}
              disabled={busy || (editing ? !!note.trim() : p.text.length < 2)}
              onPointerDown={(event) => {
                if (editing && editRef.current) {
                  // Keep the editor selection alive while the toolbar button is pressed.
                  // Browsers can move focus/selection to the button before click fires.
                  event.preventDefault();
                  const caret = getTextCaret(editRef.current);
                  if (caret !== undefined) {
                    splitAt.current = caret;
                    splitPointerAt.current = caret;
                  }
                }
              }}
              onClick={async () => {
                if (!editing) {
                  enterEditingAt();
                  return;
                }
                // Use the position captured on pointerdown. Reading Selection here is
                // too late: some browsers have already collapsed it outside the editor.
                const at = splitPointerAt.current ?? splitAt.current;
                splitPointerAt.current = undefined;
                if (draft !== p.text && !(await saveTextRef.current())) return;
                if (await action({ type: "split", at })) setEditing(false);
              }}
            >
              <Scissors size={15} />
            </button>
            <button
              title="批注"
              aria-label={`第 ${index + 1} 段批注`}
              aria-expanded={notes}
              onClick={() => setNotes(!notes)}
            >
              <ChatCircleText size={15} />
              {p.notes.length || ""}
            </button>
            <button title="移除段落（可恢复）" aria-label={`移除第 ${index + 1} 段（可恢复）`} disabled={busy} onClick={() => void action({ type: "remove" })}>
              <Trash size={15} />
            </button>
          </div>
        </header>
        {editing ? (
          <div className="paragraph-editor">
            <textarea
              value={draft}
              rows={1}
              aria-label={`第 ${index + 1} 段正文`}
              ref={editRef}
              className="paragraph-text is-editing"
              placeholder="空段落 · 点击此处开始编辑"
              onChange={(event) => {
                const textarea = event.currentTarget;
                const text = textarea.value;
                setDraft(text);
                onTextDraftChange(p.id, text);
                rememberSplitCaret(textarea);
                textarea.style.height = "auto";
                textarea.style.height = `${Math.max(56, textarea.scrollHeight)}px`;
              }}
              onSelect={(event) => rememberSplitCaret(event.currentTarget)}
              onKeyUp={(event) => rememberSplitCaret(event.currentTarget)}
              onClick={(event) => rememberSplitCaret(event.currentTarget)}
              onBlur={() => {
                if (editRef.current) rememberSplitCaret(editRef.current);
                if (autoSaveTimer.current !== undefined) {
                  window.clearTimeout(autoSaveTimer.current);
                  autoSaveTimer.current = undefined;
                }
                if (draft !== p.text && saveState !== "error")
                  void saveTextRef.current();
              }}
            />
          </div>
        ) : (
          <div
            tabIndex={0}
            ref={textRef}
            className="paragraph-text"
            onMouseUp={selectText}
            onKeyUp={selectText}
            onClick={(event) => {
              const selection = window.getSelection();
              if (
                selection?.rangeCount &&
                !selection.isCollapsed &&
                (textRef.current?.contains(selection.anchorNode) ||
                  textRef.current?.contains(selection.focusNode))
              )
                return;
              const offset = textRef.current
                ? textOffsetAtPoint(textRef.current, event.clientX, event.clientY)
                : undefined;
              if (offset === undefined) {
                enterEditingAt();
                return;
              }
              splitAt.current = offset;
              enterEditingAt(splitAt.current);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                enterEditingAt(splitAt.current);
              }
            }}
          >
            {p.text ? (
              p.text
            ) : (
                <span className="editing-muted">空段落 · 点击此处开始编辑</span>
            )}
          </div>
        )}
        {selected && workspaceActive && createPortal(
          <div ref={selectionToolbar} className="paragraph-selection" style={{ left: selectionPosition?.left ?? 0, top: selectionPosition?.top ?? 0, visibility: selectionPosition ? "visible" : "hidden" }} role="toolbar" aria-label="选中文字操作" onPointerDown={event => event.preventDefault()}>
            <span>已选文字</span>
            <button aria-label="复制选中文字" onClick={async () => {
              try { await navigator.clipboard.writeText(selected.quote); setCopied(true); setCopyFailed(false); window.setTimeout(() => setCopied(false), 1400); }
              catch { setCopyFailed(true); }
            }}><CopySimple size={13} />{copied ? "已复制" : "复制"}</button>
            <button
              disabled={busy}
              title="把选中文字拆成独立段落，插在原位置；剩余文字保持原顺序"
              onClick={async () => {
                const selection = selected;
                if (editing && draft !== p.text && !(await saveTextRef.current())) return;
                if (
                  await action({
                    type: "extractSelection",
                    start: selection.start,
                    end: selection.end,
                    quote: selection.quote,
                  })
                )
                  setSelected(undefined);
              }}
            >
              <Scissors size={13} />
              拆为独立段
            </button>
            <button onClick={() => setNotes(true)}>批注</button>
            <button
              title="暂存这段文字，之后可与其他段落的选中文字合并为独立段"
              onClick={async () => {
                const selection = selected;
                if (editing && draft !== p.text && !(await saveTextRef.current())) return;
                onStageSelection({ id: p.id, ...selection });
              }}
            >
              加入合并
            </button>
            <button onClick={() => setSelected(undefined)}>取消</button>
          </div>, document.body
        )}
        {notes && (
          <div className="paragraph-notes">
            {p.notes.map((item) => (
              <div
                key={item.id}
                className={item.resolved ? "note-resolved" : ""}
              >
                {item.quote && <blockquote>{item.quote}</blockquote>}
                <p>{item.text}</p>
                <div className="paragraph-note-actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action({
                        type: "resolveNote",
                        noteId: item.id,
                        value: !item.resolved,
                      })
                    }
                  >
                    {item.resolved ? "重新打开" : "标为已处理"}
                  </button>
                  <button
                    className="paragraph-note-delete"
                    disabled={busy}
                    aria-label="删除这条留言"
                    onClick={() => void action({ type: "deleteNote", noteId: item.id })}
                  >
                    <Trash size={12} />删除
                  </button>
                </div>
              </div>
            ))}
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (
                  !(await action({
                    type: "note",
                    text: note,
                    quote: selected?.quote || "",
                  }))
                )
                  return;
                setNote("");
                setSelected(undefined);
              }}
            >
              {selected && <blockquote>{selected.quote}</blockquote>}
              <textarea
                aria-label={`第 ${index + 1} 段批注内容`}
                placeholder="给剪辑留一句话…"
                rows={2}
                value={note}
                maxLength={10000}
                onChange={(event) => setNote(event.target.value)}
                disabled={busy}
              />
              <button disabled={busy || !note.trim()}>添加批注</button>
            </form>
          </div>
        )}
      </div>
      <div className="paragraph-references">
        <div className="reference-heading">
          <span>对应素材{links.length ? ` · ${links.length}` : ""}</span>
          <button disabled={busy} onClick={onChoose}>
            <Plus size={14} />
            添加素材
          </button>
        </div>
        <div className="reference-grid">
          {groups.map((group) => {
            const primary = group.members.find((asset) =>
              links.some(
                (link) => link.assetId === asset.id && link.role === "primary",
              ),
            );
            const asset = primary || group.cover;
            const link = links.find((link) => link.assetId === asset.id)!;
            return (
              <ReferenceMedia
                key={group.key}
                projectId={projectId}
                asset={asset}
                members={group.members}
                onStackAction={onStackAction}
                onVersionPreview={onPreview}
                link={link}
                busy={busy}
                onPreview={() => onPreview(asset)}
                onPrimary={() =>
                  void action({
                    type: "primary",
                    assetId: link.role === "primary" ? null : link.assetId,
                  })
                }
                onUnlink={() =>
                  void action({ type: "unlink", assetId: link.assetId })
                }
                onReorder={reorderGroups}
              />
            );
          })}
        </div>
        {!visible.length && (
          <button
            className="reference-drop-hint"
            disabled={busy}
            onClick={onChoose}
          >
            {primaryOnly && links.length
              ? "本段尚未指定主选"
              : "拖入图片、视频或音频"}
          </button>
        )}
        {links
          .filter((link) => !available.has(link.assetId))
          .map((link) => (
            <div className="reference-missing" key={link.assetId}>
              素材在回收站或暂不可用
              <button
                title="移除失效关联"
                aria-label="移除失效关联"
                disabled={busy}
                onClick={() =>
                  void action({ type: "unlink", assetId: link.assetId })
                }
              >
                <LinkBreak size={14} />
              </button>
            </div>
          ))}
      </div>
    </article>
  );
}
