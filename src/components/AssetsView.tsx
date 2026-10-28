import { useEffect, useRef, useState } from "react";
import { projectLabel } from "../../shared/workspace-labels.mjs";
import type { DragEvent, MouseEvent, PointerEvent, ReactNode } from "react";
import {
  UploadSimple,
  MagnifyingGlass,
  ArrowCounterClockwise,
  Trash,
  X,
  PencilSimple,
  ArrowSquareOut,
  Copy,
  GridFour,
  FrameCorners,
  Star,
  Columns,
  User, Mountains, Cube, PlayCircle, MusicNotes, SquaresFour, Tray, FilmStrip, FileText, Package,
} from "@phosphor-icons/react";
import type {
  Asset,
  AssetCategory,
  EditParagraph,
  Project,
  CanvasDocument,
} from "../types";
import { categories, libraryCategories, matchesCategory } from "../types";
import { CanvasWorkspace } from "../features/canvas/CanvasWorkspace";
import { AssetThumb } from "./AssetThumb";
import { useOriginalGrid } from "./useOriginalGrid";
import { LibraryDisplayOptions } from "./LibraryDisplayOptions";
import { droppedMediaUrl } from "../services/assetDrop";
import { bindDragCleanup } from "../services/dragLifecycle";
import type { LibraryPreferences } from "../services/libraryPreferences";
import { writeAssetDrag } from "../services/assetOutbound";
import { assetCategoryStyle } from "../services/assetCategoryTheme";
import {
  expandStackIds,
  groupAssets,
  stackMembers,
  type StackAction,
} from "../../shared/asset-stacks.mjs";
import { AssetStackHistory } from "../features/AssetStackHistory";
import { AssetCompareDialog } from "../features/AssetCompareDialog";
import { readFavorites, readSavedSearches, readPreference, writePreference, type SavedLibrarySearch } from "../services/workspacePreferences";
import { useWorkspaceScroll } from "../features/useWorkspaceScroll";

const assetKindOrder: Record<Asset["kind"], number> = {
  image: 0,
  video: 1,
  audio: 2,
  document: 3,
};
const categoryIcons = { all: GridFour, uncategorized: Tray, product: Package, character: User, scene: Mountains, prop: Cube, storyboard: FilmStrip, script: FileText, video: PlayCircle, audio: MusicNotes, other: SquaresFour };
const categoryOrder = ["uncategorized", "all", "product", "character", "scene", "prop", "video", "audio", "other", "storyboard", "script"];

type Props = {
  active?: boolean;
  importControls?: ReactNode;
  canvas?: CanvasDocument;
  onSaveCanvas: (doc: CanvasDocument, revision: number) => Promise<CanvasDocument>;
  onCanvasImport: (files: File[]) => Promise<{ ids: string[]; assets: Asset[] } | undefined>;
  assets: Asset[];
  paragraphs: EditParagraph[];
  onAttachParagraph: (ids: string[], paragraphId: string) => void;
  selected: string[];
  onSelection: (ids: string[]) => void;
  onPreview: (asset: Asset) => void;
  onUpdate: (ids: string[], patch: Partial<Asset>) => void;
  onTrash: () => void;
  onRestore: () => void;
  onImport: () => void;
  onImportFolder: () => void;
  filter: AssetCategory | "all";
  onFilter: (category: AssetCategory | "all") => void;
  projects: Project[];
  currentProjectId: string;
  onTransfer: (targetId: string) => void;
  onRename: (ids: string[], prefix: string) => Promise<void>;
  onImportCategory: (files: File[], category: AssetCategory) => void;
  onImportLink: (url: string, category: AssetCategory) => void;
  display: LibraryPreferences;
  onDisplayChange: (patch: Partial<LibraryPreferences>) => void;
  onTrashIds: (ids: string[]) => void;
  search: string;
  onSearchChange: (value: string) => void;
  trash: boolean;
  busy: boolean;
  onUse: (assets: Asset[]) => void;
  onCopy: (asset: Asset) => void;
  onPublish?: (assets: Asset[]) => void;
  onStackAction: (action: StackAction) => Promise<unknown>;
  onImportStack: (files: File[], target: Asset) => unknown;
};
export function AssetsView(props: Props) {
  const {
    assets,
    paragraphs,
    selected,
    onSelection,
    onPreview,
    onUpdate,
    filter,
    onFilter,
    search,
    trash,
    busy,
  } = props;
  const [mode, setMode] = useState<"grid" | "canvas">(() => {
    try { return localStorage.getItem(`weave.library-view.${props.currentProjectId}`) === "canvas" ? "canvas" : "grid"; }
    catch { return "grid"; }
  });
  const visibleCategories = libraryCategories(baseAssets(props.assets, props.trash));
  const [dragCategory, setDragCategory] = useState<string>("");
  useEffect(() => bindDragCleanup(window, () => setDragCategory("")), []);
  function changeMode(next: "grid" | "canvas") {
    if (next === mode) return;
    if (document.querySelector('.canvas-workspace[data-editing-dirty="true"]')) return;
    setMode(next); onSelection([]);
    try { localStorage.setItem(`weave.library-view.${props.currentProjectId}`, next); } catch {}
  }
  const viewSwitch = !trash && <div className="library-view-switch" role="group" aria-label="素材库视图">
    <button aria-pressed={mode === "grid"} onClick={() => changeMode("grid")}><GridFour size={15} />网格</button>
    <button aria-pressed={mode === "canvas"} onClick={() => changeMode("canvas")}><FrameCorners size={15} />画布</button>
  </div>;
  const preferenceKey = `weave.library-tools.${props.currentProjectId}`;
  const [sort, setSort] = useState(() => {
    const value = readPreference<any>(preferenceKey, {})?.sort;
    return ["recent", "oldest", "name", "type", "custom"].includes(value) ? value : "recent";
  });
  const [kind, setKind] = useState(() => {
    const value = readPreference<any>(preferenceKey, {})?.kind;
    return ["all", "image", "video", "audio", "document"].includes(value) ? value : "all";
  });
  const [favoritesOnly, setFavoritesOnly] = useState(() => readPreference<any>(preferenceKey, {})?.favorites === true);
  const [favorites, setFavorites] = useState(() => readFavorites(props.currentProjectId));
  const [savedSearches, setSavedSearches] = useState(() => readSavedSearches(props.currentProjectId));
  const [searchName, setSearchName] = useState("");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const searchesRef = useRef<HTMLDetailsElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useWorkspaceScroll(scrollRef, `${props.currentProjectId}:library:${trash ? "trash" : `${filter}:${kind}:${favoritesOnly}:${search}`}`, props.active !== false, mode);
  useEffect(() => { writePreference(preferenceKey, { sort, kind, favorites: favoritesOnly }); }, [preferenceKey, sort, kind, favoritesOnly]);
  useEffect(() => {
    const close = (event: globalThis.PointerEvent) => { if (searchesRef.current?.open && event.target instanceof Node && !searchesRef.current.contains(event.target)) searchesRef.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && searchesRef.current?.open) { searchesRef.current.open = false; searchesRef.current.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", close, true); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", escape); };
  }, []);
  const toggleFavorite = (asset: Asset) => {
    const key = asset.stackId || asset.id;
    const next = favorites.includes(key) ? favorites.filter(id => id !== key) : [...favorites, key];
    if (writePreference(`weave.favorites.${props.currentProjectId}`, next)) setFavorites(next);
    else setDropError("浏览器未能保存收藏，请检查本地存储空间后重试");
  };
  const orderKey = `weave.custom-order.${props.currentProjectId}.${filter}`;
  const [customOrder, setCustomOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(orderKey) || "[]"); } catch { return []; }
  });
  useEffect(() => {
    try { setCustomOrder(JSON.parse(localStorage.getItem(orderKey) || "[]")); }
    catch { setCustomOrder([]); }
  }, [orderKey]);
  const [dropError, setDropError] = useState("");
  const [rename, setRename] = useState<string>();
  const [renameError, setRenameError] = useState("");
  const [menu, setMenu] = useState<{ asset: Asset; x: number; y: number }>();
  const [historyId, setHistoryId] = useState("");
  const anchor = useRef<string>("");
  const gridRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{
    x: number;
    y: number;
    endX: number;
    endY: number;
  }>();
  const base = assets.filter((a) => (trash ? !!a.trashedAt : !a.trashedAt));
  const matching = base
    .filter(
      (a) =>
        matchesCategory(a, filter) &&
        (kind === "all" || a.kind === kind) &&
        (!favoritesOnly || favorites.includes(a.stackId || a.id)) &&
        (trash || a.status !== "rejected") &&
        `${a.name} ${a.tags.join(" ")} ${a.prompt} ${a.source}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, "zh")
        : sort === "oldest"
          ? a.createdAt.localeCompare(b.createdAt)
        : sort === "type"
            ? assetKindOrder[a.kind] - assetKindOrder[b.kind] ||
              a.name.localeCompare(b.name, "zh")
            : b.createdAt.localeCompare(a.createdAt),
    );
  const groups = trash
    ? matching.map((asset) => ({
        key: asset.id,
        cover: asset,
        members: [asset],
      }))
    : groupAssets(matching, base);
  const shown = groups.map((group) => group.cover);
  if (sort === "custom" && customOrder.length) {
    const rank = new Map(customOrder.map((id, index) => [id, index]));
    shown.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }
  const reorder = (event: DragEvent, targetId: string) => {
    if (event.altKey) return;
    const raw = event.dataTransfer.getData("application/weave-assets");
    try {
      const ids: unknown = JSON.parse(raw);
      if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "string") return;
      const sourceId = groups.find(group => group.members.some(asset => asset.id === ids[0]))?.cover.id;
      if (!sourceId || sourceId === targetId) return;
      const order = shown.map(asset => asset.id).filter(id => id !== sourceId);
      order.splice(Math.max(0, order.indexOf(targetId)), 0, sourceId);
      setCustomOrder(order); setSort("custom");
      try { localStorage.setItem(orderKey, JSON.stringify(order)); } catch {}
    } catch { /* not a Weave asset drag */ }
  };
  useOriginalGrid(
    gridRef,
    // Canvas replaces (unmounts) the grid subtree. Rebind the masonry
    // measurements when returning, even if the assets and layout are unchanged.
    props.active !== false && props.display.layout === "original" && (trash || mode === "grid"),
    shown.map((asset) => asset.id).join(","),
  );
  const whole = (ids: string[]) => (trash ? ids : expandStackIds(ids, assets));
  useEffect(() => {
    if (props.active === false) return;
    const selectAll = (event: KeyboardEvent) => {
      if (!trash && mode === "canvas") return;
      if (
        (event.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable],dialog",
        ) ||
        rename !== undefined
      )
        return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        onSelection(whole(shown.map((a) => a.id)));
      }
    };
    window.addEventListener("keydown", selectAll);
    return () => window.removeEventListener("keydown", selectAll);
  });
  const select = (asset: Asset, e: MouseEvent) => {
    if (e.shiftKey && anchor.current) {
      const anchorIndex = shown.findIndex((a) => a.id === anchor.current),
        start = anchorIndex < 0 ? 0 : anchorIndex,
        end = shown.findIndex((a) => a.id === asset.id);
      onSelection(
        whole(
          Array.from(
            new Set([
              ...selected,
              ...shown
                .slice(Math.min(start, end), Math.max(start, end) + 1)
                .map((a) => a.id),
            ]),
          ),
        ),
      );
    } else if (e.ctrlKey || e.metaKey)
      onSelection(
        whole(
          selected.includes(asset.id)
            ? selected.filter((id) => !whole([asset.id]).includes(id))
            : [...selected, asset.id],
        ),
      );
    else onSelection(whole([asset.id]));
    anchor.current = asset.id;
  };
  const pointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.button !== 0) return;
    const startX = e.clientX,
      startY = e.clientY,
      startIds = e.ctrlKey ? selected : [];
    e.currentTarget.setPointerCapture(e.pointerId);
    setBox({ x: startX, y: startY, endX: startX, endY: startY });
    const move = (event: globalThis.PointerEvent) => {
      setBox({
        x: startX,
        y: startY,
        endX: event.clientX,
        endY: event.clientY,
      });
      const ids = shown
        .filter((_, i) => {
          const rect = gridRef.current?.children[i]?.getBoundingClientRect();
          return (
            rect &&
            rect.left < Math.max(startX, event.clientX) &&
            rect.right > Math.min(startX, event.clientX) &&
            rect.top < Math.max(startY, event.clientY) &&
            rect.bottom > Math.min(startY, event.clientY)
          );
        })
        .map((a) => a.id);
      onSelection(whole(Array.from(new Set([...startIds, ...ids]))));
    };
    const end = () => {
      setBox(undefined);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };
  const dropCategory = (event: DragEvent, category: AssetCategory) => {
    if (busy) return;
    const raw = event.dataTransfer.getData("application/weave-assets");
    const files = Array.from(event.dataTransfer.files);
    const url = droppedMediaUrl(event.dataTransfer);
    if (!raw && !files.length && !url) return;
    event.preventDefault();
    event.stopPropagation();
    setDropError("");
    if (raw) {
      try {
        const ids: unknown = JSON.parse(raw);
        if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
          throw new Error();
        const valid = ids.filter((id) => base.some((asset) => asset.id === id));
        if (valid.length) onUpdate(valid, { category });
        else setDropError("拖入的素材不属于当前项目，请先加入项目。");
      } catch {
        setDropError("无法识别拖入的素材，请重新选择。");
      }
    } else if (files.length) props.onImportCategory(files, category);
    else props.onImportLink(url, category);
  };
  const categoryTabs = <div className="category-tabs library-category-tabs">
    {[...visibleCategories].sort((a, b) => categoryOrder.indexOf(a.id) - categoryOrder.indexOf(b.id)).map((c) => {
      const Icon = categoryIcons[c.id];
      return <button key={c.id} className={`${c.id === filter ? "active" : ""} ${c.id === dragCategory ? "is-drag-over" : ""} ${c.id === "all" ? "category-divider-after" : ""}`}
        data-category={c.id === "all" ? undefined : c.id} style={c.id === "all" ? undefined : assetCategoryStyle(c.id)} aria-pressed={c.id === filter}
        title={c.id === "all" ? "显示全部素材" : `${c.label}：点击筛选，拖入素材可归类`} onClick={() => { onFilter(c.id); onSelection([]); }}
        onDragEnter={event => { if (!busy && c.id !== "all") { event.preventDefault(); setDragCategory(c.id); } }}
        onDragOver={event => { if (!busy && c.id !== "all") { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragCategory(c.id); } }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragCategory(""); }}
        onDrop={event => { setDragCategory(""); if (c.id !== "all") dropCategory(event, c.id); }}>
        <Icon size={14} aria-hidden="true" /><span>{c.label}</span>
      </button>;
    })}
  </div>;
  if (!trash && mode === "canvas") return <section className="assets-workspace">
    <div className="library-view-row">{viewSwitch}{props.importControls}</div>
    <CanvasWorkspace key={props.currentProjectId}
      active={props.active !== false}
      projectId={props.currentProjectId} assets={assets} stored={props.canvas}
      search={search} toolbar={categoryTabs} filter={filter} onSave={props.onSaveCanvas}
      paragraphs={paragraphs} onAttachParagraph={props.onAttachParagraph}
      onImport={props.onCanvasImport} onUpdate={onUpdate}
      onImportCategory={props.onImportCategory} onImportLink={props.onImportLink}
      onPreview={onPreview} onCopy={props.onCopy}
      onUse={props.onUse} onStackAction={props.onStackAction} />
  </section>;
  return (
    <section className="assets-workspace">
      {!!compareIds.length && <AssetCompareDialog assets={assets} initialIds={compareIds} onClose={() => setCompareIds([])} onStackAction={props.onStackAction} />}
      {historyId &&
        assets.some((asset) => asset.id === historyId && !asset.trashedAt) && (
          <AssetStackHistory
            asset={assets.find((asset) => asset.id === historyId)!}
            assets={assets}
            onClose={() => setHistoryId("")}
            onAction={props.onStackAction}
            onPreview={onPreview}
          />
        )}
      {viewSwitch && <div className="library-view-row">{viewSwitch}{props.importControls}</div>}
      <div className="library-controls library-mode-controls">
        {categoryTabs}
        <div className="toolbar-controls">
          {!trash && <button className="library-favorites-toggle" aria-pressed={favoritesOnly} title="收藏只保存在此浏览器和当前项目" onClick={() => { setFavoritesOnly(!favoritesOnly); onSelection([]); }}><Star size={14} weight={favoritesOnly ? "fill" : "regular"} />收藏</button>}
          <select aria-label="筛选素材类型" value={kind} onChange={event => { setKind(event.target.value); onSelection([]); }}><option value="all">所有类型</option><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option><option value="document">文档</option></select>
          <details className="saved-searches" ref={searchesRef}><summary>常用筛选</summary><div className="saved-searches-menu">
            <strong>常用筛选</strong>
            {savedSearches.map(item => <div className="saved-search-item" key={item.id}><button onClick={() => {
              props.onSearchChange(item.search); onFilter(categories.some(c => c.id === item.category) ? item.category as AssetCategory | "all" : "all");
              setKind(item.kind); setFavoritesOnly(item.favorites); setSort(item.sort); onSelection([]); if (searchesRef.current) searchesRef.current.open = false;
            }}>{item.name}</button><button aria-label={`移除常用筛选 ${item.name}`} onClick={() => { const next = savedSearches.filter(x => x.id !== item.id); if (writePreference(`weave.searches.${props.currentProjectId}`, next)) setSavedSearches(next); else setDropError("无法保存筛选变更"); }}><X size={13} /></button></div>)}
            {!savedSearches.length && <p>把当前分类、搜索和排序存为常用筛选，保存在此浏览器和当前项目。</p>}
            <input aria-label="常用筛选名称" placeholder="给当前筛选起个名字" maxLength={40} value={searchName} onChange={event => setSearchName(event.target.value)} />
            <button disabled={!searchName.trim()} onClick={() => {
              const next: SavedLibrarySearch[] = [{ id: crypto.randomUUID(), name: searchName.trim(), search, category: filter, kind, favorites: favoritesOnly, sort }, ...savedSearches].slice(0, 20);
              if (writePreference(`weave.searches.${props.currentProjectId}`, next)) { setSavedSearches(next); setSearchName(""); } else setDropError("无法保存常用筛选");
            }}>保存当前筛选</button>
          </div></details>
          <select
            aria-label="素材排序"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="recent">最近加入</option>
            <option value="oldest">最早加入</option>
            <option value="name">名称排序</option>
            <option value="type">按类型排序</option>
            <option value="custom">自定义</option>
          </select>
          <LibraryDisplayOptions
            value={props.display}
            onChange={props.onDisplayChange}
          />
        </div>
      </div>
      <div className="library-scroll" ref={scrollRef} onPointerDown={pointerDown}>
        {dropError && (
          <p className="category-drop-error" role="alert">
            {dropError}
          </p>
        )}
        {shown.length ? (
          <>
            <div className="grid-note">
              <span>
                {search
                  ? "搜索结果"
                  : filter === "all"
                    ? "全部素材"
                    : categories.find((c) => c.id === filter)?.label}
                <small>{shown.length}</small>
              </span>
              <span title="Ctrl 多选 · Shift 连选 · 空格预览 · 双击放大">
                {selected.length ? `已选择 ${selected.length} 项` : ""}
              </span>
            </div>
            <div
              className={`asset-grid ${props.display.density} layout-${props.display.layout}`}
              ref={gridRef}
              onPointerDown={pointerDown}
            >
              {shown.map((asset) => (
                <AssetThumb
                  key={asset.id}
                  asset={asset}
                  projectId={props.currentProjectId}
                  favorite={favorites.includes(asset.stackId || asset.id)}
                  onFavorite={trash ? undefined : () => toggleFavorite(asset)}
                  stackCount={trash ? 1 : stackMembers(asset, assets).length}
                  onHistory={() => setHistoryId(asset.id)}
                  onStackDrop={
                    !trash && !busy && asset.kind === "video"
                      ? (event) => {
                          setDropError("");
                          const raw = event.dataTransfer.getData(
                            "application/weave-assets",
                          );
                          if (raw) {
                            try {
                              const ids: unknown = JSON.parse(raw);
                              if (
                                !Array.isArray(ids) ||
                                !ids.every((id) => typeof id === "string")
                              )
                                throw new Error("无法识别视频");
                              if (
                                ids.every((id) =>
                                  stackMembers(asset, assets).some(
                                    (item) => item.id === id,
                                  ),
                                )
                              )
                                return;
                              void props
                                .onStackAction({
                                  type: "merge",
                                  id: asset.id,
                                  assetIds: ids,
                                })
                                .catch((reason) =>
                                  setDropError((reason as Error).message),
                                );
                            } catch (reason) {
                              setDropError((reason as Error).message);
                            }
                          } else if (event.dataTransfer.files.length)
                            props.onImportStack(
                              Array.from(event.dataTransfer.files),
                              asset,
                            );
                        }
                      : undefined
                  }
                  canPreview={!trash}
                  onCopy={props.onCopy}
                  copyDisabled={busy}
                  display={props.display}
                  selected={selected.includes(asset.id)}
                  onDragStart={(event) =>
                    writeAssetDrag(
                      event.dataTransfer,
                      selected.includes(asset.id)
                        ? assets.filter((item) => selected.includes(item.id))
                        : stackMembers(asset, assets),
                    )
                  }
                  onReorderDrop={(event) => reorder(event, asset.id)}
                  onSelect={(e) => select(asset, e)}
                  onToggle={() =>
                    onSelection(
                      whole(
                        selected.includes(asset.id)
                          ? selected.filter(
                              (id) =>
                                !stackMembers(asset, assets).some(
                                  (item) => item.id === id,
                                ),
                            )
                          : [...selected, asset.id],
                      ),
                    )
                  }
                  onPreview={() => onPreview(asset)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!selected.includes(asset.id)) onSelection([asset.id]);
                    setMenu({ asset, x: e.clientX, y: e.clientY });
                  }}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-icon">
              <UploadSimple size={32} weight="light" />
            </div>
            <h2>
              {trash
                ? "回收站是空的"
                : favoritesOnly ? "没有符合条件的收藏" : search || filter !== "all" || kind !== "all"
                  ? "没有找到素材"
                  : "把素材放进来，开始创作"}
            </h2>
            <p>
              {trash
                ? "删除的素材会保留在这里，可随时恢复。"
                : favoritesOnly ? "点素材卡片上的星标加入收藏，也可以调整当前筛选。" : "拖入图片、视频或文件夹，也可以复制图片后按 Ctrl + V。"}
            </p>
            {!trash && (
              <div>
                <button className="primary-button" onClick={props.onImport}>
                  <UploadSimple size={16} />
                  导入素材
                </button>
                <button onClick={props.onImportFolder}>导入文件夹</button>
              </div>
            )}
          </div>
        )}
      </div>
      {selected.length > 0 && (
        <div className="selection-toolbar">
          <strong>已选 {selected.length} 项</strong>
          {trash ? (
            <button onClick={props.onRestore} disabled={busy}>
              <ArrowCounterClockwise size={16} />
              恢复素材
            </button>
          ) : (
            <>
              <button
                disabled={busy}
                onClick={() =>
                  props.onUse(
                    assets.filter((asset) => selected.includes(asset.id)),
                  )
                }
              >
                <ArrowSquareOut size={16} />
                用于上传
              </button>
              <button disabled={selected.filter(id => assets.some(a => a.id === id && !a.trashedAt && ["image", "video"].includes(a.kind))).length < 2} onClick={() => setCompareIds(selected.filter(id => assets.some(a => a.id === id && !a.trashedAt && ["image", "video"].includes(a.kind))).slice(0, 2))}><Columns size={16} />并排对比</button>
              {props.onPublish && (
                <button
                  disabled={
                    busy ||
                    !assets.some(
                      (asset) =>
                        selected.includes(asset.id) && asset.kind === "image",
                    )
                  }
                  onClick={() =>
                    props.onPublish!(
                      assets.filter(
                        (asset) =>
                          selected.includes(asset.id) && asset.kind === "image",
                      ),
                    )
                  }
                >
                  收录到公共库
                </button>
              )}
              <select
                aria-label="加入其他项目"
                value=""
                disabled={busy}
                onChange={(e) => props.onTransfer(e.target.value)}
              >
                <option value="">加入项目…</option>
                {props.projects
                  .filter((p) => p.id !== props.currentProjectId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {projectLabel(p)}
                    </option>
                  ))}
              </select>
              <select
                aria-label="批量分类"
                value=""
                disabled={busy}
                onChange={(e) =>
                  onUpdate(selected, {
                    category: e.target.value as AssetCategory,
                  })
                }
              >
                <option value="">归类到…</option>
                {visibleCategories
                  .filter((c) => c.id !== "all")
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
              </select>
              <button
                disabled={busy}
                onClick={() => {
                  setRename("镜头");
                  setRenameError("");
                }}
              >
                <PencilSimple size={14} />
                批量改名
              </button>
              <button
                className="danger"
                onClick={props.onTrash}
                disabled={busy}
              >
                <Trash size={16} />
                移入回收站
              </button>
            </>
          )}
          <button
            className="selection-close"
            title="取消选择"
            onClick={() => onSelection([])}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {box && (
        <div
          className="selection-box"
          style={{
            left: Math.min(box.x, box.endX),
            top: Math.min(box.y, box.endY),
            width: Math.abs(box.x - box.endX),
            height: Math.abs(box.y - box.endY),
          }}
        />
      )}
      {menu && (
        <div
          className="context-backdrop"
          onClick={() => setMenu(undefined)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(undefined);
          }}
        >
          <div
            className="context-menu"
            role="menu"
            style={{
              left: Math.min(menu.x, window.innerWidth - 200),
              top: Math.max(8, Math.min(menu.y, window.innerHeight - 240)),
            }}
          >
            {!trash && menu.asset.kind === "image" && (
              <button
                role="menuitem"
                disabled={busy}
                onClick={() => {
                  props.onCopy(menu.asset);
                  setMenu(undefined);
                }}
              >
                <Copy size={15} />
                复制图片
              </button>
            )}
            {!trash && (
              <button
                role="menuitem"
                disabled={busy}
                onClick={() => {
                  props.onUse(
                    selected.includes(menu.asset.id)
                      ? assets.filter((asset) => selected.includes(asset.id))
                      : [menu.asset],
                  );
                  setMenu(undefined);
                }}
              >
                <ArrowSquareOut size={15} />
                用于上传
              </button>
            )}
            {!trash && (
              <button role="menuitem" onClick={() => onPreview(menu.asset)}>
                <MagnifyingGlass size={15} />
                放大预览
              </button>
            )}
            {trash && (
              <button role="menuitem" disabled={busy} onClick={props.onRestore}>
                恢复素材
              </button>
            )}
            {!trash && (
              <>
                <button
                  role="menuitem"
                  disabled={busy}
                  onClick={() => onUpdate([menu.asset.id], { status: "final" })}
                >
                  设为最终稿
                </button>
                <button
                  role="menuitem"
                  disabled={busy}
                  className="danger"
                  onClick={() =>
                    props.onTrashIds(
                      selected.includes(menu.asset.id)
                        ? selected
                        : [menu.asset.id],
                    )
                  }
                >
                  <Trash size={15} />
                  移入回收站
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {rename !== undefined && (
        <div className="modal-backdrop">
          <form
            className="small-modal"
            onSubmit={async (e) => {
              e.preventDefault();
              setRenameError("");
              try {
                await props.onRename(selected, rename.trim());
                setRename(undefined);
              } catch (error) {
                setRenameError((error as Error).message);
              }
            }}
          >
            <div className="modal-title">
              <h2>批量改名</h2>
              <button
                type="button"
                disabled={busy}
                onClick={() => setRename(undefined)}
              >
                <X size={19} />
              </button>
            </div>
            <label>
              名称前缀
              <input
                autoFocus
                value={rename}
                onChange={(e) => setRename(e.target.value)}
                required
              />
            </label>
            <p>
              {rename || "素材"}_001、{rename || "素材"}_002…
              保留各自扩展名，不改动原文件内容。
            </p>
            {renameError && <p className="feature-error">{renameError}</p>}
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => setRename(undefined)}
                disabled={busy}
              >
                取消
              </button>
              <button
                className="primary-button"
                disabled={busy || !rename.trim()}
              >
                重命名 {selected.length} 项
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

function baseAssets(assets: Asset[], trash: boolean) {
  // Legacy tabs are retained in trash too, so recovering them never requires reclassification.
  return assets.filter(a => trash ? !!a.trashedAt : !a.trashedAt).map(a => trash ? { ...a, trashedAt: undefined } : a);
}
