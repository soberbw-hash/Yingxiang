import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  FileText,
  CopySimple,
  Plus,
  Download,
  X,
  FolderOpen,
  MusicNote,
  Scissors,
} from "@phosphor-icons/react";
import type { Asset, EditAction, EditDocument, ProjectSnapshot } from "../types";
import {
  prepareAudioDragFile,
  prepareVideoDragFile,
  startNativeAssetDrag,
  writeAssetDrag,
  writeMediaFileDrag,
} from "../services/assetOutbound";
import {
  buildEditingHandoff,
  buildEditingVideos,
  planEditingVideos,
  downloadHandoff,
} from "../services/editingHandoff";
import { ParagraphCard } from "./editing/ParagraphCard";
import { PasteDocumentDialog } from "./editing/PasteDocumentDialog";
import { FeatureDialog, errorText } from "./shared";
import "./editing/editing.css";
import { validateEditing } from "../../shared/editing.mjs";
import { groupAssets, type StackAction } from "../../shared/asset-stacks.mjs";
import { DocumentHistory } from "./editing/DocumentHistory";
import { VideoDeliveryList } from "./editing/VideoDeliveryList";
import { useWorkspaceScroll } from "./useWorkspaceScroll";
import { readScrollBookmark } from "../services/workspacePreferences";

export function EditingWorkspace({
  active = true,
  snapshot,
  projectId,
  onEdit,
  onImport,
  onPreview,
  onStackAction,
}: {
  active?: boolean;
  snapshot: ProjectSnapshot;
  projectId: string;
  onEdit: (action: EditAction, revision: number) => Promise<unknown>;
  onImport: (files: File[]) => Promise<string[] | undefined>;
  onPreview: (asset: Asset) => void;
  onStackAction: (action: StackAction) => Promise<unknown>;
}) {
  type StagedTextSelection = { id: string; start: number; end: number; quote: string };
  const { doc, formatError } = useMemo(() => {
    try {
      return {
        doc: snapshot.editing
          ? validateEditing(snapshot.editing, snapshot.assets)
          : undefined,
        formatError: "",
      };
    } catch (reason) {
      return { doc: undefined, formatError: errorText(reason) };
    }
  }, [snapshot.editing, snapshot.assets]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const busyRef = useRef(false),
    current = useRef(doc);
  current.current = doc;
  const past = useRef<Array<{ document: EditDocument | undefined; revision: number; label: string }>>([]),
    future = useRef<Array<{ document: EditDocument | undefined; revision: number; label: string }>>([]),
    revision = useRef(doc?.revision || 0);
  if (doc && doc.revision > revision.current) revision.current = doc.revision;
  const [, setHistoryVersion] = useState(0);
  const [paste, setPaste] = useState(false),
    [drawer, setDrawer] = useState(false),
    [target, setTarget] = useState("");
  const [search, setSearch] = useState(""),
    [mediaKind, setMediaKind] = useState("all");
  const [mergeSelection, setMergeSelection] = useState<string[]>([]);
  const [stagedSelections, setStagedSelections] = useState<StagedTextSelection[]>([]);
  const mergeAnchor = useRef<number | null>(null);
  const draftTexts = useRef(new Map<string, string>());
  const [draftCount, setDraftCount] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deliveryMode, setDeliveryMode] = useState<"videos" | "handoff">("videos");
  const scrollRef = useRef<HTMLDivElement>(null);
  useWorkspaceScroll(scrollRef, `${projectId}:editing`, active, doc?.id || "empty");
  const updateDraftText = useCallback((id: string, text: string | null) => {
    if (text === null) draftTexts.current.delete(id);
    else draftTexts.current.set(id, text);
    setDraftCount(draftTexts.current.size);
  }, []);
  const [restore, setRestore] = useState(false),
    [sources, setSources] = useState(false),
    [exporting, setExporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const assets = snapshot.assets.filter(
      (a) => !a.trashedAt && a.kind !== "document",
    ),
    paragraphs = doc?.paragraphs || [];
  const activeIds = new Set(assets.map((a) => a.id));
  const delivery = useMemo(() => {
    try { return { plan: doc ? planEditingVideos(doc, snapshot.assets) : undefined, error: "" }; }
    catch (reason) { return { plan: undefined, error: errorText(reason) }; }
  }, [doc, snapshot.assets]);
  const visible = paragraphs.filter(
    (p) =>
      (!search ||
        p.text.includes(search) ||
        p.notes.some((n) => n.text.includes(search))),
  );
  const mergeIndexes = mergeSelection.map(id => paragraphs.findIndex(p => p.id === id)).sort((a, b) => a - b);
  const canMergeSelected = mergeIndexes.length >= 2 && mergeIndexes[0] >= 0 && mergeIndexes.every((index, offset) => offset === 0 || index === mergeIndexes[offset - 1] + 1);
  const mergeSelected = () => {
    if (!canMergeSelected) return;
    return work(async () => {
      const retainedAssetIds = new Set(
        paragraphs
          .slice(mergeIndexes[0], mergeIndexes[mergeIndexes.length - 1] + 1)
          .flatMap((paragraph) => paragraph.links.map((link) => link.assetId)),
      );
      if (document.querySelector('.editing-paragraph[data-note-dirty="true"]'))
        throw new Error("请先保存正在填写的批注，再合并段落");
      for (const [id, text] of [...draftTexts.current]) {
        const paragraph = current.current?.paragraphs.find((item) => item.id === id);
        if (!paragraph || paragraph.text === text) {
          draftTexts.current.delete(id);
          continue;
        }
        await saveEdit({ type: "text", id, text });
        draftTexts.current.delete(id);
      }
      setDraftCount(draftTexts.current.size);
      await saveEdit({
        type: "merge",
        id: paragraphs[mergeIndexes[0]].id,
        count: mergeIndexes.length - 1,
      });
      setMergeSelection([]);
      mergeAnchor.current = null;
      setMessage(`段落已合并，保留 ${retainedAssetIds.size} 个素材版本关联`);
    });
  };
  const stageTextSelection = (selection: StagedTextSelection) => {
    setStagedSelections((items) => items.some((item) =>
      item.id === selection.id && item.start === selection.start && item.end === selection.end,
    ) ? items : [...items, selection]);
  };
  const canCombineStaged = stagedSelections.length >= 2 &&
    new Set(stagedSelections.map((item) => item.id)).size >= 2;
  const combineStagedSelections = () => work(async () => {
    if (!canCombineStaged) throw new Error("请从两个不同段落中加入选中文字");
    if (document.querySelector('.editing-workspace [data-editing-dirty="true"]'))
      throw new Error("请等待文字自动保存后，再合并选中文字");
    await saveEdit({ type: "combineSelections", selections: stagedSelections });
    setStagedSelections([]);
    setMessage("选中文字已合并为独立段落");
  });
  useEffect(() => {
    setMergeSelection([]);
    mergeAnchor.current = null;
  }, [search]);
  const toggleMergeSelection = (index: number, extend: boolean) => {
    if (extend && mergeAnchor.current !== null) {
      const start = Math.min(mergeAnchor.current, index), end = Math.max(mergeAnchor.current, index);
      setMergeSelection(paragraphs.slice(start, end + 1).map((paragraph) => paragraph.id));
      return;
    }
    if (mergeSelection.length === 1 && mergeSelection[0] === paragraphs[index].id) {
      setMergeSelection([]);
      mergeAnchor.current = null;
      return;
    }
    if (mergeSelection.length) {
      const selectedIndexes = mergeSelection
        .map((id) => paragraphs.findIndex((paragraph) => paragraph.id === id))
        .filter((selectedIndex) => selectedIndex >= 0);
      const start = Math.min(...selectedIndexes), end = Math.max(...selectedIndexes);
      if (index === start - 1 || index === end + 1) {
        setMergeSelection(paragraphs.slice(Math.min(index, start), Math.max(index, end) + 1).map((paragraph) => paragraph.id));
        return;
      }
    }
    mergeAnchor.current = index;
    setMergeSelection([paragraphs[index].id]);
  };
  const completeDocumentText = () => paragraphs
    .map((paragraph) => draftTexts.current.get(paragraph.id) ?? paragraph.text)
    .join("\n\n")
    .trimEnd();
  const exportCompleteDocument = () => {
    const text = completeDocumentText();
    if (!text) {
      setError("文稿还没有可导出的正文");
      return;
    }
    const baseName = (doc?.title || "剪辑文稿")
      .replace(/[<>:\"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\.txt$/i, "")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 120) || "剪辑文稿";
    const url = URL.createObjectURL(new Blob(["\uFEFF", text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${baseName}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setError("");
    setMessage(`完整文稿已导出：${baseName}.txt`);
  };
  const [limit, setLimit] = useState(() => Math.max(50, (readScrollBookmark(`${projectId}:editing`)?.index || 0) + 20));
  const [assetSearch, setAssetSearch] = useState("");
  const canDiscardInputs = () =>
    !document.querySelector('.editing-workspace [data-editing-dirty="true"]') ||
    window.confirm(
      "还有正在自动保存的文字或未提交批注。继续离开可能丢失这些修改，确定继续？",
    );
  async function work(action: () => Promise<void>) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      return true;
    } catch (reason) {
      setError(errorText(reason));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const actionLabel = (action: EditAction) => ({
    text: "编辑文字", split: "分段", extractSelection: "拆出独立段落", combineSelections: "合并选中文字", merge: "合并段落", move: "调整段落顺序", moveTo: "调整段落顺序",
    remove: "移除段落", restore: "恢复段落", generated: "标记完成", link: "关联素材",
    unlink: "解除素材关联", primary: "调整素材主选", reorderLinks: "调整素材顺序",
    note: "添加批注", resolveNote: "更新批注", deleteNote: "删除留言", import: "导入文稿", add: "添加段落",
    title: "修改文稿名称", legacy: "复制旧镜头", restoreDocument: "恢复历史版本",
  } as Record<string, string>)[action.type] || "修改文稿";
  const saveEdit = async (action: EditAction) => {
    const before = current.current ? structuredClone(current.current) : undefined;
    const expected = revision.current;
    const result = await onEdit(action, expected);
    const response = result as { revision?: number; editing?: EditDocument; snapshot?: { editing?: EditDocument } } | undefined;
    const resultRevision = response?.revision ?? response?.editing?.revision ?? response?.snapshot?.editing?.revision;
    revision.current = typeof resultRevision === "number" && Number.isInteger(resultRevision) ? resultRevision : expected + 1;
    const committed = response?.editing ?? response?.snapshot?.editing;
    if (committed) current.current = committed;
    {
      past.current.push({ document: before, revision: revision.current, label: actionLabel(action) });
      while (past.current.length > 30 || JSON.stringify(past.current).length > 16_000_000) past.current.shift();
      future.current = [];
      setHistoryVersion((value) => value + 1);
    }
    return result;
  };
  const commands = useRef<Promise<unknown>>(Promise.resolve());
  const command = (action: EditAction) => {
    const task = commands.current.then(() => work(async () => {
      if (
        ["remove", "merge", "restoreDocument"].includes(action.type) &&
        document.querySelector('.editing-workspace [data-editing-dirty="true"]')
      )
        throw new Error("请等待文字自动保存，并先提交批注，再合并或移除段落");
      await saveEdit(action);
      if (action.type !== "text") setMessage("已保存");
    }));
    commands.current = task.catch(() => {});
    return task;
  };
  const moveHistory = (redo: boolean) => work(async () => {
    if (document.querySelector('.editing-workspace [data-editing-dirty="true"]'))
      throw new Error("请先等待文字或批注自动保存，再撤回或重做");
    const source = redo ? future.current : past.current;
    const target = redo ? past.current : future.current;
    const entry = source[source.length - 1];
    if (!entry) return;
    if (revision.current !== entry.revision) {
      past.current = []; future.current = [];
      setHistoryVersion((value) => value + 1);
      throw new Error("文稿已在其他窗口更新，撤回历史已失效；请刷新后重试");
    }
    const before = current.current ? structuredClone(current.current) : undefined;
    const result = await onEdit({ type: "restoreDocument", document: entry.document ?? null }, revision.current);
    const response = result as { revision?: number; editing?: EditDocument; snapshot?: { editing?: EditDocument } } | undefined;
    const resultRevision = response?.revision ?? response?.editing?.revision ?? response?.snapshot?.editing?.revision;
    revision.current = typeof resultRevision === "number" && Number.isInteger(resultRevision) ? resultRevision : revision.current + 1;
    const committed = response?.editing ?? response?.snapshot?.editing;
    if (committed) current.current = committed;
    source.pop();
    // Our own restore increments the document revision. Keep the next history
    // entry in this stack at that revision; an external edit still invalidates it.
    if (source.length) source[source.length - 1].revision = revision.current;
    target.push({ document: before, revision: revision.current, label: entry.label });
    setHistoryVersion((value) => value + 1);
    setMessage(redo ? `已重做：${entry.label}` : `已撤回：${entry.label}`);
  });
  const moveHistoryRef = useRef(moveHistory);
  moveHistoryRef.current = moveHistory;
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      if ((event.target as HTMLElement | null)?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
      event.preventDefault();
      void moveHistoryRef.current(event.shiftKey);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);
  const importToParagraph = (files: File[], id: string) =>
    work(async () => {
      const ids = await onImport(files);
      if (!ids) return;
      if (!ids.length)
        throw new Error("未找到可关联的素材；不支持的格式不会建立空关联");
      await saveEdit({ type: "link", id, assetIds: ids });
      setMessage("已保存原片并关联段落");
    });
  if (formatError)
    return (
      <section className="editing-workspace">
        <p role="alert" className="editing-error">
          {formatError}。原文稿仍保留，请勿用空白内容覆盖。
        </p>
      </section>
    );
  return (
    <section
      className="editing-workspace"
      aria-label="剪辑对照"
      onPaste={(event) => {
        if (
          (event.target as HTMLElement).closest(
            'input,textarea,[contenteditable="true"]',
          )
        )
          return;
        const files = Array.from(event.clipboardData.files);
        if (!files.length) return;
        event.preventDefault();
        event.stopPropagation();
        if (target) void importToParagraph(files, target);
        else setError("请先点段落旁的「添加素材」，再粘贴图片");
      }}
    >
      <header className="editing-toolbar">
        <div>
          <h1>剪辑对照</h1>
          <span className="editing-save" role="status">
            {busy ? "正在处理…" : error ? "保存或操作未完成 · 查看提示" : draftCount ? "等待自动保存…" : doc ? "更改已保存" : ""}
          </span>
        </div>
        <div className="editing-actions">
          {doc && <input
            className="editing-document-search"
            aria-label="搜索文稿与批注"
            placeholder="搜索文稿、批注"
            value={search}
            onChange={(event) => {
              if (!canDiscardInputs()) return;
              setSearch(event.target.value);
              setLimit(50);
            }}
          />}
          {mergeSelection.length > 0 && (
            <button className="paragraph-merge-selected" disabled={busy || !canMergeSelected} title={canMergeSelected ? "合并选中的连续段落；未保存的正文会先自动保存" : "再点击一个相邻段落，或按住 Shift 选择范围"} onClick={() => void mergeSelected()}>
              合并所选 {mergeSelection.length} 段
            </button>
          )}
          <button disabled={busy || !doc} onClick={() => setHistoryOpen(true)}>文稿历史</button>
          <button disabled={busy || !past.current.length} onClick={() => void moveHistory(false)} title="撤回上一步 · Ctrl+Z" aria-label="撤回上一步">
            <ArrowCounterClockwise size={16} />撤回
          </button>
          <button disabled={busy || !future.current.length} onClick={() => void moveHistory(true)} title="重做 · Ctrl+Shift+Z" aria-label="重做">
            <ArrowClockwise size={16} />重做
          </button>
          {paragraphs.length ? (
            <button disabled={busy} title="将所有段落正文导出为 UTF-8 文本文件" onClick={exportCompleteDocument}>
              <Download size={16} />
              导出完整文稿
            </button>
          ) : (
            <button disabled={busy} onClick={() => setPaste(true)}>
              <FileText size={16} />
              粘贴文稿
            </button>
          )}
          <button disabled={busy} onClick={() => void command({ type: "add" })}>
            <Plus size={16} />
            添加段落
          </button>
          <button aria-pressed={drawer} onClick={() => setDrawer(!drawer)}>
            <FolderOpen size={16} />
            项目素材
          </button>
          <button
            disabled={busy || !paragraphs.length}
            onClick={() => {
              if (document.querySelector('.editing-workspace [data-editing-dirty="true"]')) { setError("请先等待文字自动保存，并提交正在填写的批注，再导出当前文稿"); return; }
              setExporting(true);
            }}
          >
            <Download size={16} />
            导出视频 / 交接
          </button>
          {doc && <details className="editing-more">
            <summary>更多</summary>
            <div>
              <button disabled={!doc.sources.length} onClick={() => setSources(true)}>原始文稿</button>
              <button onClick={() => setRestore(true)}>已移除段落（{doc.removed.length}）</button>
              {snapshot.shots.length > 0 && <button disabled={busy} onClick={() => void command({ type: "legacy" })}>复制旧镜头为段落</button>}
            </div>
          </details>}
        </div>
      </header>
      {error && (
        <p className="editing-error" role="alert">
          {error}
        </p>
      )}
      <div className="editing-layout">
        <div className="editing-document">
          {!!stagedSelections.length && (
            <div className="editing-selection-staging" role="region" aria-label="待合并的选中文字">
              <div className="editing-selection-staging-heading">
                <strong>待合并片段 · {stagedSelections.length}</strong>
                <span>按原文顺序组成一段，放在来源段落之间</span>
              </div>
              <div className="editing-selection-staging-items">
                {stagedSelections.map((item, index) => {
                  const sourceIndex = paragraphs.findIndex((paragraph) => paragraph.id === item.id);
                  return (
                    <div className="editing-selection-staging-item" key={`${item.id}:${item.start}:${item.end}`}>
                      <span>{String(sourceIndex + 1).padStart(2, "0")} · {item.quote.slice(0, 90)}{item.quote.length > 90 ? "…" : ""}</span>
                      <button
                        title="复制此片段"
                        aria-label={`复制第 ${index + 1} 个选中文字`}
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(item.quote);
                            setMessage("选中文字已复制");
                          } catch {
                            setError("复制失败：浏览器未授予剪贴板权限");
                          }
                        }}
                      ><CopySimple size={13} /></button>
                      <button
                        title="从待合并列表移除，不改动原文"
                        aria-label={`移除第 ${index + 1} 个暂存片段`}
                        onClick={() => setStagedSelections((items) => items.filter((_, i) => i !== index))}
                      ><X size={13} /></button>
                    </div>
                  );
                })}
              </div>
              <div className="editing-selection-staging-actions">
                <button disabled={busy || !canCombineStaged} title="将选中文字从原段落取出，合并为中间的新段落" onClick={() => void combineStagedSelections()}>
                  <Scissors size={14} />合并为独立段
                </button>
                <button disabled={busy} onClick={() => setStagedSelections([])}>清空</button>
              </div>
            </div>
          )}
          <div className="editing-scroll" ref={scrollRef}>
            {!paragraphs.length && (
              <div className="editing-empty">
                <FileText size={34} weight="duotone" />
                <h2>先放入文稿，再把素材拖到段落旁</h2>
                <p>图片、视频、音频，都和对应文字放在一起。</p>
                <button
                  className="editing-primary"
                  onClick={() => setPaste(true)}
                >
                  粘贴整篇文稿
                </button>
                {snapshot.shots.length > 0 && (
                  <button
                    disabled={busy}
                    onClick={() => void command({ type: "legacy" })}
                  >
                    保留旧记录，复制 {snapshot.shots.length} 个镜头为段落
                  </button>
                )}
              </div>
            )}
            {visible.slice(0, limit).map((p) => (
              <ParagraphCard
                key={p.id}
                projectId={projectId}
                paragraph={p}
                index={paragraphs.indexOf(p)}
                total={paragraphs.length}
                assets={snapshot.assets}
                busy={busy}
                onTextDraftChange={updateDraftText}
                primaryOnly={false}
                mergeSelected={mergeSelection.includes(p.id)}
                onToggleMerge={(extend) => toggleMergeSelection(paragraphs.indexOf(p), extend)}
                onStageSelection={stageTextSelection}
                active={target === p.id && drawer}
                workspaceActive={active}
                onAction={command}
                onReorder={(sourceId, index) => command({ type: "moveTo", id: sourceId, index })}
                onDropFiles={async (files) => {
                  await importToParagraph(files, p.id);
                }}
                onChoose={() => {
                  setTarget(p.id);
                  setDrawer(true);
                }}
                onPreview={onPreview}
                onStackAction={onStackAction}
              />
            ))}
            {!!paragraphs.length && !visible.length && (
              <p className="editing-empty">没有符合条件的段落</p>
            )}
            {visible.length > limit && (
              <button
                className="editing-load"
                onClick={() => setLimit(limit + 50)}
              >
                继续显示后面的段落
              </button>
            )}
          </div>
        </div>
        {drawer && (
          <aside className="editing-asset-drawer" aria-label="项目素材">
            <header>
              <strong>项目素材</strong>
              <button aria-label="关闭素材栏" onClick={() => setDrawer(false)}>
                <X size={18} />
              </button>
            </header>
            <select
              aria-label="要添加素材的段落"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="">选择对应段落…</option>
              {paragraphs.map((p, i) => (
                <option key={p.id} value={p.id}>
                  {String(i + 1).padStart(2, "0")} ·{" "}
                  {p.text.slice(0, 22) || "空段落"}
                </option>
              ))}
            </select>
            <input
              aria-label="搜索项目素材"
              placeholder="搜索素材名称"
              value={assetSearch}
              onChange={(event) => setAssetSearch(event.target.value)}
            />
            <div className="editing-drawer-filters">
              <select
                aria-label="素材类型"
                value={mediaKind}
                onChange={(event) => setMediaKind(event.target.value)}
              >
                <option value="all">全部类型</option>
                <option value="image">图片</option>
                <option value="video">视频</option>
                <option value="audio">音频</option>
              </select>
              <button
                disabled={busy || !target}
                onClick={() => fileInput.current?.click()}
              >
                导入到本段
              </button>
            </div>
            <p className="editing-muted">拖到段落旁，或选择段落后点添加。</p>
            <div className="editing-drawer-list">
              {groupAssets(
                assets.filter(
                  (a) =>
                    (mediaKind === "all" || a.kind === mediaKind) &&
                    a.name
                      .toLocaleLowerCase()
                      .includes(assetSearch.toLocaleLowerCase()),
                ),
                assets,
              ).map(({ cover: asset, members }) => (
                <article
                  key={asset.id}
                  data-preview-asset={asset.id}
                  draggable={!busy}
                  onPointerEnter={() => {
                    if (asset.kind === "audio") void prepareAudioDragFile(asset).catch(() => {});
                    if (asset.kind === "video") void prepareVideoDragFile(asset).catch(() => {});
                  }}
                  onDragStart={(event) => {
                    if (startNativeAssetDrag(event, projectId, asset.id)) return;
                    writeAssetDrag(event.dataTransfer, members);
                    writeMediaFileDrag(event.dataTransfer, asset);
                  }}
                >
                  <button
                    className="editing-drawer-thumb"
                    aria-label={`预览 ${asset.name}`}
                    onClick={() => onPreview(asset)}
                  >
                    {asset.kind === "image" ? (
                      <img
                        src={asset.url}
                        alt={asset.name}
                        loading="lazy"
                        draggable
                      />
                    ) : asset.kind === "video" ? (
                      <video src={asset.url} preload="none" />
                    ) : (
                      <MusicNote size={25} />
                    )}
                  </button>
                  <span title={asset.name}>
                    {asset.name}
                    {members.length > 1 ? ` · ${members.length} 版` : ""}
                  </span>
                  <button
                    disabled={busy || !target}
                    aria-label={`添加 ${asset.name} 到段落`}
                    onClick={() =>
                      void command({
                        type: "link",
                        id: target,
                        assetIds: [asset.id],
                      })
                    }
                  >
                    <Plus size={16} />
                  </button>
                </article>
              ))}
              {!assets.length && (
                <p className="editing-muted">
                  项目还没有素材，也可以直接拖本地文件到段落旁。
                </p>
              )}
            </div>
          </aside>
        )}
      </div>
      <input
        ref={fileInput}
        hidden
        type="file"
        multiple
        accept="image/*,video/*,audio/*,.mp3,.wav,.m4a,.ogg,.flac"
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          event.target.value = "";
          if (files.length && target) void importToParagraph(files, target);
        }}
      />
      {paste && (
        <PasteDocumentDialog
          busy={busy}
          error={error}
          onClose={() => setPaste(false)}
          onImport={async (text, mode) => {
            if (await command({ type: "import", text, mode })) setPaste(false);
          }}
        />
      )}
      {restore && (
        <FeatureDialog
          title="已移除段落"
          busy={busy}
          onClose={() => setRestore(false)}
        >
          <div className="editing-removed">
            {!doc?.removed.length && <p>暂无已移除段落</p>}
            {doc?.removed.map((item) => (
              <article key={item.paragraph.id}>
                <p>{item.paragraph.text || "空段落"}</p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void command({ type: "restore", id: item.paragraph.id })
                  }
                >
                  <ArrowCounterClockwise size={15} />
                  恢复
                </button>
              </article>
            ))}
          </div>
        </FeatureDialog>
      )}
      {sources && (
        <FeatureDialog title="原始文稿" onClose={() => setSources(false)} wide>
          <div className="editing-removed">
            {doc?.sources.map((source, i) => (
              <details key={source.id}>
                <summary>
                  第 {i + 1} 次粘贴 ·{" "}
                  {new Date(source.createdAt).toLocaleString("zh-CN")}
                </summary>
                <pre>{source.text}</pre>
              </details>
            ))}
          </div>
        </FeatureDialog>
      )}
      {exporting && (
        <FeatureDialog
          title="视频与文稿交付"
          busy={busy}
          onClose={() => setExporting(false)}
        >
          <div className="editing-export">
            <div className="export-purpose" role="group" aria-label="剪辑交付内容"><button aria-pressed={deliveryMode === "videos"} onClick={() => setDeliveryMode("videos")}>视频原片</button><button aria-pressed={deliveryMode === "handoff"} onClick={() => setDeliveryMode("handoff")}>文稿交接包</button></div>
            {error && <p className="editing-error" role="alert">{error}</p>}
            {deliveryMode === "handoff" && <>
            <p>包含当前段落、批注与已关联原片。</p>
            <p className="editing-muted">
              解压后打开「剪辑对照.html」即可查阅。不包含已移除段落、旧镜头
              Prompt 或未关联素材。
            </p>
            <button
              disabled={busy}
              className="editing-primary"
              onClick={() =>
                void work(async () => {
                  if (!doc) return;
                  const result = await buildEditingHandoff(
                    doc,
                    snapshot.assets,
                    async (asset) => {
                      const response = await fetch(asset.url || "");
                      if (!response.ok)
                        throw new Error(`无法读取原片：${asset.name}`);
                      return response.blob();
                    },
                  );
                  downloadHandoff(result.blob, result.name);
                  setExporting(false);
                  setMessage("交接包已生成并请求下载，请在下载列表确认保存");
                })
              }
            >
              {busy ? "正在校验并打包…" : "导出文稿交接 ZIP"}
            </button>
            </>}
            {deliveryMode === "videos" && <>
            {doc && <VideoDeliveryList document={doc} assets={snapshot.assets} />}
            <div className="editing-export-videos">
              <p>
                全部原片放在 ZIP 内的“剪辑视频”文件夹；解压后按名称排序，即可按文稿顺序导入剪辑软件。
              </p>
              <button
                className="editing-primary"
                disabled={busy || !delivery.plan?.files.length || delivery.plan.totalBytes > 300 * 1024 * 1024}
                onClick={() =>
                  void work(async () => {
                    if (!doc) return;
                    const result = await buildEditingVideos(
                      doc,
                      snapshot.assets,
                      async (asset) => {
                        const response = await fetch(asset.url || "");
                        if (!response.ok)
                          throw new Error(`无法读取原片：${asset.name}`);
                        return response.blob();
                      },
                    );
                    downloadHandoff(result.blob, result.name);
                    setExporting(false);
                    setMessage(`已打包 ${result.fileCount} 个视频并请求下载，请在下载列表确认保存`);
                  })
                }
              >
                {busy ? "正在校验并打包…" : "导出全部关联视频"}
              </button>
            </div>
            </>}
          </div>
        </FeatureDialog>
      )}
      {historyOpen && doc && <DocumentHistory current={doc} versions={snapshot.editingHistory || []} assets={snapshot.assets} busy={busy} error={error} onClose={() => setHistoryOpen(false)} onRestore={version => command({ type: "restoreDocument", document: version.document })} />}
    </section>
  );
}
