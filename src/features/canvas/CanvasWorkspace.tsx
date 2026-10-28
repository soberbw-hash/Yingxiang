import { useEffect, useRef, useState } from "react";
import type { DragEvent, PointerEvent as ReactPointerEvent, ReactNode, FormEvent, KeyboardEvent } from "react";
import { ArrowCounterClockwise, ArrowClockwise, Plus, FrameCorners, Hand, Cursor,
  NotePencil, CaretDown, CaretRight, Lock, LockOpen, X, SquaresFour, CornersOut,
  Minus, Check, ArrowSquareOut, Crosshair } from "@phosphor-icons/react";
import type { Asset, AssetCategory, CanvasDocument, CanvasFrame, CanvasNode, EditParagraph } from "../../types";
import { matchesCategory } from "../../types";
import { assetNode, arrangeNodes, canvasAsset, canvasAssetIds, moveCanvasItems } from "../../../shared/canvas.mjs";
import { groupAssets, stackMembers, type StackAction } from "../../../shared/asset-stacks.mjs";
import { writeAssetDrag } from "../../services/assetOutbound";
import { useCanvasDocument } from "./useCanvasDocument";
import { CanvasMedia } from "./CanvasMedia";
import { AssetStackHistory } from "../AssetStackHistory";
import { FeatureDialog } from "../shared";
import "./canvas.css";

type Props = {
  active?: boolean;
  assets: Asset[]; stored?: CanvasDocument; projectId: string; search: string;
  toolbar: ReactNode; filter: AssetCategory | "all"; paragraphs: EditParagraph[];
  onSave: (doc: CanvasDocument, revision: number) => Promise<CanvasDocument>;
  onPreview: (asset: Asset) => void; onCopy: (asset: Asset) => void;
  onUse: (assets: Asset[]) => void; onStackAction: (action: StackAction) => Promise<unknown>;
  onAttachParagraph: (ids: string[], paragraphId: string) => void;
  onImport: (files: File[]) => Promise<{ ids: string[]; assets: Asset[] } | undefined>;
  onUpdate: (ids: string[], patch: Partial<Asset>) => void;
  onImportCategory: (files: File[], category: AssetCategory) => void;
  onImportLink: (url: string, category: AssetCategory) => void;
};

type Gesture = { pointerId: number; mode: "pan" | "move" | "resize" | "box";
  startX: number; startY: number; before: CanvasDocument;
  nodes: string[]; frames: string[]; itemId?: string; moved: boolean };
type Edit = { kind: "frame" | "note"; id?: string; title: string; text: string };
const targetIsControl = (target: EventTarget) => (target as Element).closest("button,input,textarea,select,[contenteditable]");

export function CanvasWorkspace(props: Props) {
  const { assets, stored, search } = props;
  const state = useCanvasDocument(stored, assets, props.onSave, props.active !== false);
  const { doc } = state;
  const [draft, setDraft] = useState<CanvasDocument>();
  const board = draft || doc;
  const boardRef = useRef(board); boardRef.current = board;
  const wheelTimer = useRef<number | undefined>(undefined);
  const [trayLimit, setTrayLimit] = useState(80);
  const [selected, setSelected] = useState<string[]>([]), [selectedFrame, setSelectedFrame] = useState("");
  const [tool, setTool] = useState<"select" | "hand">("select");
  const [tray, setTray] = useState(true), [traySearch, setTraySearch] = useState("");
  const [editing, setEditing] = useState<Edit>(), [history, setHistory] = useState("");
  const [operationError, setOperationError] = useState("");
  const [box, setBox] = useState<{ x: number; y: number; width: number; height: number }>();
  const viewport = useRef<HTMLDivElement>(null), gesture = useRef<Gesture | undefined>(undefined);
  const skipClick = useRef(false);
  const [dimensions, setDimensions] = useState({ width: 1000, height: 700 });
  const dragOver = useRef(0);
  const [dropFrame, setDropFrame] = useState("");
  const [importing, setImporting] = useState(false);
  const disabled = state.saving || state.dirty || importing;
  const currentFrame = board.frames.find(f => f.id === selectedFrame);
  const visibleAssets = assets.filter(a => !a.trashedAt);
  const placed = new Set(board.nodes.flatMap(n => {
    const asset = canvasAsset(n, assets); return asset ? [asset.stackId || asset.id] : [];
  }));
  const unplaced = groupAssets(visibleAssets).map(g => g.cover).filter(a => !placed.has(a.stackId || a.id));
  const trayAssets = unplaced.filter(a => matchesCategory(a, props.filter) && `${a.name} ${a.tags.join(" ")}`.toLowerCase().includes(traySearch.toLowerCase()));
  const selectedIds = canvasAssetIds(board, selectedFrame ? board.nodes.filter(n => n.frameId === selectedFrame).map(n => n.id) : selected, assets);
  useEffect(() => { setSelected([]); setSelectedFrame(""); }, [props.filter]);
  const nodeMatchesFilter = (node: CanvasNode) => node.kind === "note" || props.filter === "all" || (() => { const asset = canvasAsset(node, assets); return !!asset && matchesCategory(asset, props.filter); })();
  const matches = board.nodes.filter(n => n.kind === "note" ? n.text?.includes(search) : (() => {
    const a = canvasAsset(n, assets); return a && `${a.name} ${a.tags.join(" ")} ${a.prompt}`.toLowerCase().includes(search.toLowerCase());
  })());
  const matchKey = matches.map(n => n.id).join(",");
  const view = board.viewport;
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const observer = new ResizeObserver(() => setDimensions({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = viewport.current;
    const prevent = (event: WheelEvent) => event.preventDefault();
    element?.addEventListener("wheel", prevent, { passive: false });
    return () => { element?.removeEventListener("wheel", prevent); window.clearTimeout(wheelTimer.current); };
  }, []);
  useEffect(() => {
    const cancel = () => { gesture.current = undefined; setDraft(undefined); setBox(undefined); setDropFrame(""); };
    window.addEventListener("blur", cancel);
    return () => window.removeEventListener("blur", cancel);
  }, []);
  async function commit(next: CanvasDocument, source = assets, remember = true) {
    setOperationError("");
    try { return await state.persist(next, remember, source); }
    catch (reason) { setOperationError((reason as Error).message); return false; }
  }
  function syncIntrinsicRatio(nodeId: string, ratio: number) {
    if (!Number.isFinite(ratio) || ratio < 0.01 || ratio > 100 || state.saving || state.dirty) return;
    const current = boardRef.current;
    const node = current.nodes.find(item => item.id === nodeId);
    if (!node || node.kind !== "asset" || node.mediaRatio !== undefined && Math.abs(Math.log(node.mediaRatio / ratio)) < 0.01) return;
    const next = structuredClone(current), changed = next.nodes.find(item => item.id === nodeId)!;
    const fittedRatio = changed.width / Math.max(1, changed.height - 30);
    if (Math.abs(Math.log(fittedRatio / ratio)) > 0.04)
      changed.height = Math.max(110, changed.width / ratio + 30);
    changed.mediaRatio = ratio;
    if (changed.frameId) growFrame(next, changed.frameId);
    void commit(next, assets, false);
  }
  function world(clientX: number, clientY: number, source = board) {
    const rect = viewport.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - source.viewport.x) / source.viewport.zoom,
      y: (clientY - rect.top - source.viewport.y) / source.viewport.zoom };
  }
  function frameAt(x: number, y: number) {
    return [...board.frames].reverse().find(f => !f.locked && !f.collapsed &&
      x >= f.x && x <= f.x + f.width && y >= f.y + 44 && y <= f.y + f.height);
  }
  function center() { return { x: (dimensions.width / 2 - view.x) / view.zoom, y: (dimensions.height / 2 - view.y) / view.zoom }; }
  function fit(nodes = board.nodes, frames = board.frames) {
    const items = [...nodes.filter(n => !board.frames.find(f => f.id === n.frameId)?.collapsed), ...frames.map(f => ({ ...f, height: f.collapsed ? 48 : f.height }))];
    if (!items.length) return;
    const left = Math.min(...items.map(n => n.x)), top = Math.min(...items.map(n => n.y));
    const right = Math.max(...items.map(n => n.x + n.width)), bottom = Math.max(...items.map(n => n.y + n.height));
    const zoom = Math.max(.15, Math.min(1.3, (dimensions.width - 100) / (right - left), (dimensions.height - 100) / (bottom - top)));
    void commit({ ...board, viewport: { zoom, x: dimensions.width / 2 - (left + right) / 2 * zoom, y: dimensions.height / 2 - (top + bottom) / 2 * zoom } });
  }
  function focusMostAssets() {
    const nodes = board.nodes.filter(n => n.kind === "asset" && canvasAsset(n, assets) &&
      !board.frames.find(f => f.id === n.frameId)?.collapsed);
    if (!nodes.length) return;

    // Find the densest viewport-sized neighborhood, so this works even when
    // the canvas has several separate groups spread far apart.
    const referenceZoom = .8;
    const halfWidth = dimensions.width / referenceZoom / 2;
    const halfHeight = dimensions.height / referenceZoom / 2;
    const current = center();
    const ranked = nodes.map(seed => {
      const x = seed.x + seed.width / 2, y = seed.y + seed.height / 2;
      const members = nodes.filter(node => {
        const nx = node.x + node.width / 2, ny = node.y + node.height / 2;
        return Math.abs(nx - x) <= halfWidth && Math.abs(ny - y) <= halfHeight;
      });
      return { members, distance: (x - current.x) ** 2 + (y - current.y) ** 2 };
    }).sort((a, b) => b.members.length - a.members.length || a.distance - b.distance);
    const focus = ranked[0].members;
    const left = Math.min(...focus.map(n => n.x)), top = Math.min(...focus.map(n => n.y));
    const right = Math.max(...focus.map(n => n.x + n.width)), bottom = Math.max(...focus.map(n => n.y + n.height));
    const padding = 96;
    const zoom = Math.max(.2, Math.min(1.2,
      (dimensions.width - padding) / Math.max(1, right - left),
      (dimensions.height - padding) / Math.max(1, bottom - top)));
    void commit({ ...board, viewport: {
      zoom,
      x: dimensions.width / 2 - (left + right) / 2 * zoom,
      y: dimensions.height / 2 - (top + bottom) / 2 * zoom,
    } });
  }
  // Search moves the camera, not the items; clearing search never rearranges the board.
  useEffect(() => {
    if (!search || state.saving || state.dirty || !matches.length) return;
    const first = matches[0], parent = doc.frames.find(f => f.id === first.frameId);
    if (parent?.collapsed) return;
    const zoom = Math.max(.5, Math.min(1, doc.viewport.zoom));
    void commit({ ...doc, viewport: { zoom, x: dimensions.width / 2 - (first.x + first.width / 2) * zoom, y: dimensions.height / 2 - (first.y + first.height / 2) * zoom } });
  // Re-running on save would repeatedly re-center while the user pans search results.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, matchKey]);
  function start(event: ReactPointerEvent, mode: Gesture["mode"], id?: string, frame = false) {
    if (disabled || gesture.current || (event.button !== 0 && event.button !== 1)) return;
    // Let the browser own native image drag-out. Capturing this pointer and
    // preventing its default would turn an external drag into a canvas move.
    if (mode === "move" && (event.target as Element).closest(".asset-picture img[draggable='true']")) return;
    if (targetIsControl(event.target) && mode !== "resize") return;
    event.preventDefault(); event.stopPropagation();
    viewport.current?.focus({ preventScroll: true });
    const pan = event.button === 1 || tool === "hand";
    let nodes = selected, frames = selectedFrame ? [selectedFrame] : [];
    if (!pan && id) {
      if (frame) { if (board.frames.find(f => f.id === id)?.locked) return; frames = [id]; nodes = []; setSelectedFrame(id); setSelected([]); }
      else {
        const item = board.nodes.find(n => n.id === id);
        if (board.frames.find(f => f.id === item?.frameId)?.locked) return;
        frames = []; setSelectedFrame("");
        nodes = selected.includes(id) ? selected : event.ctrlKey || event.metaKey ? [...selected, id] : [id];
        setSelected(nodes);
      }
    }
    if (!pan && mode === "box") { if (!event.ctrlKey) { setSelected([]); nodes = []; } setSelectedFrame(""); frames = []; }
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointerId: event.pointerId, mode: pan ? "pan" : mode,
      startX: event.clientX, startY: event.clientY, before: board, nodes, frames, itemId: id, moved: false };
  }
  function move(event: ReactPointerEvent) {
    const g = gesture.current; if (!g || g.pointerId !== event.pointerId) return;
    const px = event.clientX - g.startX, py = event.clientY - g.startY;
    if (!g.moved && Math.hypot(px, py) < 3) return;
    g.moved = true;
    const dx = px / g.before.viewport.zoom, dy = py / g.before.viewport.zoom;
    if (g.mode === "pan") setDraft({ ...g.before, viewport: { ...g.before.viewport, x: g.before.viewport.x + px, y: g.before.viewport.y + py } });
    else if (g.mode === "move") setDraft(moveCanvasItems(g.before, g.nodes, g.frames, dx, dy));
    else if (g.mode === "resize") {
      const next = structuredClone(g.before), item = next.nodes.find(n => n.id === g.itemId) || next.frames.find(f => f.id === g.itemId);
      if (item) { const isFrame = "title" in item; item.width = Math.max(isFrame ? 280 : 100, Math.min(isFrame ? 10000 : 2000, item.width + dx)); item.height = Math.max(isFrame ? 160 : 70, Math.min(isFrame ? 10000 : 2000, item.height + dy)); }
      setDraft(next);
    } else {
      const a = world(g.startX, g.startY, g.before), b = world(event.clientX, event.clientY, g.before);
      const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
      setBox(rect);
      setSelected([...new Set([...g.nodes, ...board.nodes.filter(n =>
        nodeMatchesFilter(n) && !board.frames.find(f => f.id === n.frameId)?.collapsed && n.x < rect.x + rect.width && n.x + n.width > rect.x && n.y < rect.y + rect.height && n.y + n.height > rect.y).map(n => n.id)])]);
    }
  }
  function end(event: ReactPointerEvent, canceled = false) {
    const g = gesture.current; if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = undefined;
    const next = draft;
    setDraft(undefined); setBox(undefined);
    if (canceled || !g.moved) return;
    skipClick.current = true; setTimeout(() => { skipClick.current = false; }, 0);
    if (!next || g.mode === "box") return;
    if (g.mode === "move" && !g.frames.length) {
      const point = world(event.clientX, event.clientY), destination = frameAt(point.x, point.y);
      for (const node of next.nodes) if (g.nodes.includes(node.id)) {
        if (destination) node.frameId = destination.id; else delete node.frameId;
      }
    }
    void commit(next);
  }
  async function addAssets(ids: string[], x: number, y: number, frameId?: string, source = assets) {
    const next = structuredClone(state.current.current);
    const groups = groupAssets(source.filter(a => ids.includes(a.id) && !a.trashedAt), source);
    const fresh = groups.filter(group => !next.nodes.some(n => n.frameId === frameId && canvasAsset(n, source) && (canvasAsset(n, source)!.stackId || canvasAsset(n, source)!.id) === group.key));
    const added = arrangeNodes(fresh.map(g => assetNode(g.cover, 0, 0, frameId)), x, y, frameId ? next.frames.find(f => f.id === frameId)!.width - 48 : 900);
    next.nodes.push(...added);
    if (frameId) growFrame(next, frameId);
    if (added.length && await commit(next, source)) { setSelected(added.map(n => n.id)); setSelectedFrame(""); }
  }
  function growFrame(next: CanvasDocument, id: string) {
    const frame = next.frames.find(f => f.id === id)!;
    const children = next.nodes.filter(n => n.frameId === id);
    frame.width = Math.min(10000, Math.max(frame.width, ...children.map(n => n.x + n.width - frame.x + 24)));
    frame.height = Math.min(10000, Math.max(frame.height, ...children.map(n => n.y + n.height - frame.y + 24)));
  }
  function packWidth(nodes: CanvasNode[]) {
    const columns = Math.ceil(Math.sqrt(nodes.length));
    const widest = Math.max(...nodes.map(node => node.width));
    return Math.max(widest, Math.min(1200, columns * widest + (columns - 1) * 20));
  }
  function accept(event: DragEvent) {
    if (disabled || !event.dataTransfer.types.some(t => t === "application/weave-assets" || t === "Files")) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy";
    const point = world(event.clientX, event.clientY); setDropFrame(frameAt(point.x, point.y)?.id || "");
    dragOver.current = Date.now();
  }
  async function drop(event: DragEvent) {
    event.preventDefault(); event.stopPropagation(); setDropFrame("");
    if (disabled) return;
    const point = world(event.clientX, event.clientY), frame = frameAt(point.x, point.y);
    const raw = event.dataTransfer.getData("application/weave-assets");
    try {
      if (raw) {
        const ids: unknown = JSON.parse(raw);
        if (!Array.isArray(ids) || !ids.every(id => typeof id === "string") || !ids.some(id => assets.some(a => a.id === id))) throw new Error("请先把其他项目的素材加入当前项目");
        await addAssets(ids, point.x, point.y, frame?.id);
      } else if (event.dataTransfer.files.length) {
        setImporting(true);
        const result = await props.onImport(Array.from(event.dataTransfer.files));
        if (result?.ids.length) await addAssets(result.ids, point.x, point.y, frame?.id, result.assets);
      }
    } catch (reason) { setOperationError((reason as Error).message); }
    finally { setImporting(false); }
  }
  function tidy() {
    const next = structuredClone(board);
    const frame = next.frames.find(f => f.id === selectedFrame);
    const categoryOrder = ["product", "character", "scene", "storyboard", "script", "video", "audio", "other", "uncategorized"];
    const nodes = (frame
      ? next.nodes.filter(n => n.kind === "asset" && n.frameId === frame.id)
      : selected.length
        ? next.nodes.filter(n => n.kind === "asset" && selected.includes(n.id) && !next.frames.find(f => f.id === n.frameId)?.locked)
        : next.nodes.filter(n => n.kind === "asset" && !n.frameId))
      .sort((a, b) => {
        const aa = a.assetId ? assets.find(item => item.id === a.assetId) : undefined;
        const bb = b.assetId ? assets.find(item => item.id === b.assetId) : undefined;
        const category = (aa ? categoryOrder.indexOf(aa.category === "prop" ? "uncategorized" : aa.category) : 99) - (bb ? categoryOrder.indexOf(bb.category === "prop" ? "uncategorized" : bb.category) : 99);
        if (category) return category;
        const created = (aa?.createdAt || "").localeCompare(bb?.createdAt || "");
        return created || (aa?.name || "").localeCompare(bb?.name || "", "zh");
      });
    if (!nodes.length || frame?.locked) return;
    const width = packWidth(nodes);
    const packed = arrangeNodes(nodes, frame ? frame.x + 24 : Math.min(...nodes.map(n => n.x)), frame ? frame.y + 64 : Math.min(...nodes.map(n => n.y)), width);
    const map = new Map(packed.map(n => [n.id, n])); next.nodes = next.nodes.map(n => map.get(n.id) || n);
    if (frame) {
      frame.width = Math.max(320, ...packed.map(n => n.x + n.width - frame.x + 24));
      frame.height = Math.max(160, ...packed.map(n => n.y + n.height - frame.y + 24));
    }
    void commit(next);
  }
  function remove() {
    if (currentFrame?.locked) return;
    const next = structuredClone(board);
    if (selectedFrame) { next.frames = next.frames.filter(f => f.id !== selectedFrame); next.nodes.forEach(n => { if (n.frameId === selectedFrame) delete n.frameId; }); }
    else next.nodes = next.nodes.filter(n => !selected.includes(n.id) || board.frames.find(f => f.id === n.frameId)?.locked);
    void commit(next); setSelected([]); setSelectedFrame("");
  }
  function changeFrame(patch: Partial<CanvasFrame>) {
    void commit({ ...board, frames: board.frames.map(f => f.id === selectedFrame ? { ...f, ...patch } : f) });
  }
  function saveEdit(event: FormEvent) {
    event.preventDefault(); if (!editing) return;
    const next = structuredClone(board), point = center();
    if (editing.kind === "frame") {
      let frame = next.frames.find(f => f.id === editing.id);
      if (!frame) {
        const children = next.nodes.filter(n => selected.includes(n.id) && !board.frames.find(f => f.id === n.frameId)?.locked);
        const bounds = children.length ? {
          x: Math.min(...children.map(n => n.x)), y: Math.min(...children.map(n => n.y)),
          right: Math.max(...children.map(n => n.x + n.width)), bottom: Math.max(...children.map(n => n.y + n.height)),
        } : undefined;
        frame = { id: crypto.randomUUID(), title: "", note: "",
          x: bounds ? bounds.x - 24 : point.x - 380,
          y: bounds ? bounds.y - 64 : point.y - 200,
          width: bounds ? Math.max(320, bounds.right - bounds.x + 48) : 760,
          height: bounds ? Math.max(190, bounds.bottom - bounds.y + 88) : 420,
          collapsed: false, locked: false };
        next.frames.push(frame); children.forEach(n => { n.frameId = frame!.id; });
      }
      frame.title = editing.title.trim() || "未命名区域"; frame.note = editing.text;
      setSelectedFrame(frame.id); setSelected([]);
    } else {
      const node = next.nodes.find(n => n.id === editing.id);
      if (node) node.text = editing.text;
      else { const id = crypto.randomUUID(); const frame = next.frames.find(f => f.id === selectedFrame && !f.locked && !f.collapsed);
        next.nodes.push({ id, kind: "note", text: editing.text, x: frame ? frame.x + 24 : point.x - 120, y: frame ? frame.y + 64 : point.y - 60, width: 240, height: 150, ...(frame ? { frameId: frame.id } : {}) });
        setSelected([id]); setSelectedFrame(""); if (frame) growFrame(next, frame.id); }
    }
    void commit(next); setEditing(undefined);
  }
  function zoomBy(factor: number) {
    const zoom = Math.max(.15, Math.min(3, view.zoom * factor)), point = center();
    void commit({ ...board, viewport: { zoom, x: dimensions.width / 2 - point.x * zoom, y: dimensions.height / 2 - point.y * zoom } });
  }
  function key(event: KeyboardEvent) {
    if (targetIsControl(event.target) || disabled) return;
    if (event.key === "Escape") { gesture.current = undefined; setDraft(undefined); setBox(undefined); setSelected([]); setSelectedFrame(""); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); setSelected(board.nodes.filter(nodeMatchesFilter).filter(n => !board.frames.find(f => f.id === n.frameId)?.collapsed).map(n => n.id)); setSelectedFrame(""); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); void (event.shiftKey ? state.redo() : state.undo()); }
    else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); remove(); }
    else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault(); const step = event.shiftKey ? 40 : 10;
      void commit(moveCanvasItems(board, selected, selectedFrame ? [selectedFrame] : [], event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0));
    }
  }
  const onScreen = (item: CanvasNode | CanvasFrame) => (item.x + item.width) * view.zoom + view.x > -400 && item.x * view.zoom + view.x < dimensions.width + 400 &&
    (item.y + item.height) * view.zoom + view.y > -400 && item.y * view.zoom + view.y < dimensions.height + 400;
  const tidyCount = currentFrame
    ? board.nodes.filter(n => n.kind === "asset" && n.frameId === currentFrame.id).length
    : selected.length
      ? board.nodes.filter(n => n.kind === "asset" && selected.includes(n.id) && !board.frames.find(f => f.id === n.frameId)?.locked).length
      : board.nodes.filter(n => n.kind === "asset" && !n.frameId).length;
  return <section className="canvas-workspace" data-editing-dirty={state.dirty || !!editing || state.saving || !!draft ? "true" : undefined} data-save-state={state.error ? "error" : state.saving ? "saving" : state.dirty ? "pending" : "idle"}>
    <div className="canvas-toolbar">
      {props.toolbar}
      <div className="canvas-toolbar-actions">
        {(state.saving || state.dirty) && <span className="canvas-save-state" role="status">{state.saving ? "保存中…" : "未保存"}</span>}
        <button disabled={disabled || !state.canUndo} onClick={() => void state.undo()} title="撤销 · Ctrl Z" aria-label="撤销"><ArrowCounterClockwise size={17} /></button>
        <button disabled={disabled || !state.canRedo} onClick={() => void state.redo()} title="重做 · Ctrl Shift Z" aria-label="重做"><ArrowClockwise size={17} /></button>
        <button disabled={disabled || props.filter !== "all" || tidyCount < 2 || !!currentFrame?.locked} onClick={tidy} title={props.filter !== "all" ? "切换到全部素材后整理，避免移动隐藏的素材" : currentFrame ? "整理当前区域内的素材" : selected.length ? "整理选中的素材" : "整理所有未归组素材；按分类分组，同类内按加入时间从早到晚排列。可用 Ctrl+Z 撤销。"}><SquaresFour size={16} />按类型整理</button>
        <button disabled={disabled} title={selected.length ? `把选中的 ${selected.length} 项素材组成一个区域` : "在当前视口新建空区域；也可先框选素材再创建区域"} onClick={() => setEditing({ kind: "frame", title: "", text: "" })}><FrameCorners size={17} />{selected.length ? `组成区域 · ${selected.length}` : "新建区域"}</button>
        <button disabled={disabled} onClick={() => setEditing({ kind: "note", title: "", text: "" })} title="添加便签" aria-label="添加便签"><NotePencil size={17} /></button>
        <button aria-pressed={tray} onClick={() => setTray(!tray)}>未摆放 <small>{unplaced.length}</small></button>
      </div>
    </div>
    {(state.error || operationError) && <div className="canvas-error" role="alert"><span>{state.error || operationError}</span>{state.dirty && <button onClick={() => state.reload()}>载入已保存布局</button>}<button onClick={() => setOperationError("")}>关闭提示</button></div>}
    <div className={`canvas-body ${props.filter !== "all" ? "canvas-filtered" : ""}`}>
      <div ref={viewport} className={`canvas-viewport tool-${tool}`} role="region" aria-label="项目素材画布" tabIndex={0}
        onKeyDown={key} onPointerDown={e => { if (e.target === e.currentTarget || (e.target as Element).classList.contains("canvas-world")) start(e, "box"); }}
        onPointerMove={move} onPointerUp={e => end(e)} onPointerCancel={e => end(e, true)}
        onDragEnter={accept} onDragOver={accept} onDrop={event => void drop(event)}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropFrame(""); }}
        onContextMenu={e => { if (e.target === e.currentTarget) e.preventDefault(); }}
        onWheel={e => {
          if (disabled) return;
          // Wheel pans; Ctrl/trackpad pinch zooms around the pointer. Saving occurs on idle.
          const before = boardRef.current;
          const rect = viewport.current!.getBoundingClientRect(), vx = e.clientX - rect.left, vy = e.clientY - rect.top;
          const zoom = e.ctrlKey ? Math.max(.15, Math.min(3, before.viewport.zoom * Math.exp(-e.deltaY * .005))) : before.viewport.zoom;
          const next = { ...before, viewport: e.ctrlKey ? { zoom, x: vx - (vx - before.viewport.x) / before.viewport.zoom * zoom, y: vy - (vy - before.viewport.y) / before.viewport.zoom * zoom } : { zoom, x: before.viewport.x - e.deltaX, y: before.viewport.y - e.deltaY } };
          boardRef.current = next; setDraft(next);
          window.clearTimeout(wheelTimer.current);
          wheelTimer.current = window.setTimeout(() => { setDraft(undefined); void commit(boardRef.current); }, 220);
        }}>
        <div className="canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
          {board.frames.filter(onScreen).map(frame => <section key={frame.id} className={`canvas-frame ${selectedFrame === frame.id ? "is-selected" : ""} ${dropFrame === frame.id ? "drop-target" : ""}`}
            data-frame-id={frame.id} style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.collapsed ? 48 : frame.height }}
            onClick={e => { e.stopPropagation(); if (!skipClick.current) { setSelectedFrame(frame.id); setSelected([]); } }}>
            <header onPointerDown={e => start(e, "move", frame.id, true)} onDoubleClick={() => { if (!frame.locked && !disabled) setEditing({ kind: "frame", id: frame.id, title: frame.title, text: frame.note }); }}>
              <button aria-label={`${frame.collapsed ? "展开" : "折叠"} ${frame.title}`} disabled={disabled} onClick={e => { e.stopPropagation(); void commit({ ...board, frames: board.frames.map(f => f.id === frame.id ? { ...f, collapsed: !f.collapsed } : f) }); }}>{frame.collapsed ? <CaretRight size={14} /> : <CaretDown size={14} />}</button>
              <strong>{frame.title}</strong><small>{board.nodes.filter(n => n.frameId === frame.id).length}</small>{frame.locked && <Lock size={13} />}
            </header>
            {!frame.collapsed && frame.note && <p className="canvas-frame-note">{frame.note}</p>}
            {!frame.collapsed && selectedFrame === frame.id && !frame.locked && <button className="canvas-resize" aria-label={`调整区域大小 ${frame.title}`} onPointerDown={e => start(e, "resize", frame.id, true)} />}
          </section>)}
          {board.nodes.filter(n => !board.frames.find(f => f.id === n.frameId)?.collapsed && onScreen(n) && nodeMatchesFilter(n)).map(node => {
            const asset = canvasAsset(node, assets), locked = board.frames.find(f => f.id === node.frameId)?.locked;
            return <div key={node.id} className={`canvas-node ${node.kind === "note" ? "canvas-note" : ""} ${selected.includes(node.id) ? "is-selected" : ""} ${search && matches.some(n => n.id === node.id) ? "search-match" : ""}`}
              data-canvas-node={node.id} style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
              onPointerDown={e => start(e, "move", node.id)}
              onDragStart={e => { e.stopPropagation(); }}
              onClick={e => { e.stopPropagation(); if (!skipClick.current) { setSelected(e.ctrlKey || e.metaKey ? selected.includes(node.id) ? selected.filter(id => id !== node.id) : [...selected, node.id] : [node.id]); setSelectedFrame(""); } }}>
              {asset ? <CanvasMedia asset={asset} assets={assets} nodeId={node.id} selected={selected.includes(node.id)} onSelect={() => { if (!skipClick.current) { setSelected([node.id]); setSelectedFrame(""); } }} onIntrinsicRatio={syncIntrinsicRatio} onCopy={props.onCopy}
                onPreview={() => props.onPreview(asset)} onHistory={() => setHistory(asset.id)} onUse={props.onUse} /> : node.kind === "note" ? <div className="canvas-note-content" role="button" tabIndex={0} onDoubleClick={() => { if (!disabled && !locked) setEditing({ kind: "note", id: node.id, title: "", text: node.text || "" }); }} onKeyDown={e => { if (e.key === "Enter" && !disabled && !locked) setEditing({ kind: "note", id: node.id, title: "", text: node.text || "" }); }}>{node.text || "双击写便签"}</div> : <div className="canvas-unavailable">原素材在回收站中<br /><small>恢复素材后可继续显示</small></div>}
              {selected.includes(node.id) && !locked && <button className="canvas-resize" aria-label="调整素材大小" onPointerDown={e => start(e, "resize", node.id)} />}
            </div>;
          })}
          {box && <div className="canvas-marquee" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />}
        </div>
        {!board.nodes.length && !board.frames.length && <div className="canvas-empty"><FrameCorners size={38} weight="light" /><h2>把有关的素材放在一起</h2><p>从右侧拖入素材，框选后组成区域</p><button disabled={disabled || !unplaced.length} onClick={() => void addAssets(unplaced.slice(0, 24).map(a => a.id), 24, 24)}>摆入{unplaced.length > 24 ? "前 24 个" : "现有"}素材</button></div>}
        {(selected.length > 0 || currentFrame) && <div className="canvas-context-tools" onPointerDown={e => e.stopPropagation()}>
          <span>{currentFrame ? currentFrame.title : `已选 ${selected.length} 项`}</span>
          {currentFrame && <><button disabled={disabled} onClick={() => changeFrame({ locked: !currentFrame.locked })} title={currentFrame.locked ? "解锁区域" : "锁定区域"}>{currentFrame.locked ? <Lock size={15} /> : <LockOpen size={15} />}</button><button disabled={disabled || currentFrame.locked} onClick={() => setEditing({ kind: "frame", id: currentFrame.id, title: currentFrame.title, text: currentFrame.note })}>编辑</button></>}
          {selectedIds.length > 0 && <select aria-label="画布素材加入剪辑段落" value="" disabled={disabled || !props.paragraphs.length} onChange={e => props.onAttachParagraph(selectedIds.filter(id => assets.find(a => a.id === id)?.kind !== "document"), e.target.value)}><option value="">加入剪辑段落…</option>{props.paragraphs.map((p, i) => <option key={p.id} value={p.id}>{String(i + 1).padStart(2, "0")} · {p.text.slice(0, 18)}</option>)}</select>}
          <button disabled={disabled || currentFrame?.locked} onClick={remove} title="仅移出画布，不删除原素材" aria-label={currentFrame ? "解散区域，保留素材" : "移出画布，不删除素材"}><X size={16} /></button>
        </div>}
        <div className="canvas-navigation" onPointerDown={e => e.stopPropagation()}>
          <button aria-label="选择工具" aria-pressed={tool === "select"} onClick={() => setTool("select")}><Cursor size={17} /></button><button aria-label="平移工具" aria-pressed={tool === "hand"} onClick={() => setTool("hand")}><Hand size={17} /></button>
          <i /><button disabled={disabled} onClick={() => zoomBy(.8)} aria-label="缩小"><Minus size={15} /></button><span>{Math.round(view.zoom * 100)}%</span><button disabled={disabled} onClick={() => zoomBy(1.25)} aria-label="放大"><Plus size={15} /></button><button disabled={disabled || !board.nodes.some(n => n.kind === "asset" && canvasAsset(n, assets))} onClick={focusMostAssets} title="回到素材最多处" aria-label="回到素材最多处"><Crosshair size={17} /></button><button disabled={disabled || !board.nodes.length && !board.frames.length} onClick={() => fit()} title="查看全部" aria-label="查看全部"><CornersOut size={17} /></button>
          {board.frames.length > 0 && <select aria-label="跳转区域" value="" disabled={disabled} onChange={e => { const f = board.frames.find(f => f.id === e.target.value); if (f) fit([], [f]); }}><option value="">区域…</option>{board.frames.map(f => <option key={f.id} value={f.id}>{f.title}</option>)}</select>}
        </div>
      </div>
      {tray && <aside className="canvas-tray"><header><strong>未摆放</strong><small>{unplaced.length}</small><button aria-label="收起未摆放素材" onClick={() => setTray(false)}><X size={16} /></button></header><input aria-label="查找未摆放素材" placeholder="查找素材" value={traySearch} onChange={e => setTraySearch(e.target.value)} />
        <div className="canvas-tray-assets">{trayAssets.slice(0, trayLimit).map(asset => <div className="canvas-tray-item" key={asset.id} draggable data-preview-asset={asset.id} onDragStart={e => { e.stopPropagation(); writeAssetDrag(e.dataTransfer, stackMembers(asset, assets)); }}>
          <CanvasMedia asset={asset} assets={assets} selected={false} onSelect={() => {}} onCopy={props.onCopy} onPreview={() => props.onPreview(asset)} onHistory={() => setHistory(asset.id)} onUse={props.onUse} />
          <button className="canvas-place" disabled={disabled} aria-label={`摆入画布 ${asset.name}`} onClick={() => { const point = center(); const frame = currentFrame && !currentFrame.locked && !currentFrame.collapsed ? currentFrame : undefined; void addAssets([asset.id], frame ? frame.x + 24 : point.x - 100, frame ? frame.y + 64 : point.y - 70, frame?.id); }}><Plus size={15} /></button>
        </div>)}{trayAssets.length > trayLimit && <button onClick={() => setTrayLimit(trayLimit + 80)}>加载更多</button>}{!trayAssets.length && <p className="canvas-tray-empty">{traySearch ? "没有找到素材" : "素材都已摆入画布"}</p>}</div>
      </aside>}
    </div>
    {history && assets.some(a => a.id === history && !a.trashedAt) && <AssetStackHistory asset={assets.find(a => a.id === history)!} assets={assets} onAction={props.onStackAction} onClose={() => setHistory("")} onPreview={props.onPreview} />}
    {editing && <FeatureDialog title={editing.kind === "frame" ? "区域" : "便签"} onClose={() => setEditing(undefined)}><form className="canvas-edit-form" onSubmit={saveEdit}>{editing.kind === "frame" && <><p className="canvas-edit-hint">{editing.id ? "修改区域名称或备注。" : selected.length ? `保存后，选中的 ${selected.length} 项素材会自动放入这个区域。` : "保存后会在当前视口创建一个空区域；之后可把素材拖进来。"}</p><label>名称<input autoFocus required maxLength={160} placeholder="例如：卧室开场" value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} /></label></>}<label>{editing.kind === "frame" ? "备注" : "内容"}<textarea autoFocus={editing.kind === "note"} maxLength={editing.kind === "frame" ? 4000 : 10000} rows={5} value={editing.text} onChange={e => setEditing({ ...editing, text: e.target.value })} /></label><footer><button type="button" onClick={() => setEditing(undefined)}>取消</button><button className="primary-button" type="submit"><Check size={15} />保存</button></footer></form></FeatureDialog>}
  </section>;
}
