import { useEffect, useRef, useState } from "react";
import { projectLabel } from "../../shared/workspace-labels.mjs";
import {
  Copy,
  FolderOpen,
  Plus,
  ArrowsClockwise,
  Trash,
  ArrowCounterClockwise,
  ArrowDown,
  Bell,
  GridFour, Tray, Package, User, Mountains, PlayCircle, MusicNotes, SquaresFour, FilmStrip,
} from "@phosphor-icons/react";
import { AssetThumb } from "../components/AssetThumb";
import { useOriginalGrid } from "../components/useOriginalGrid";
import { AssetPreview } from "./AssetPreview";
import { copyAssetImage } from "../services/assetOutbound";
import { assetCategoryStyle } from "../services/assetCategoryTheme";
import { hashBlob, readDiskFile } from "../services/directoryFiles";
import {
  editSharedAsset,
  libraryGroups,
  sharedAssetBlob,
  imageLibraryInput,
  publishToLibrary,
  sharedConflictVersions,
  resolveSharedConflict,
  type LibraryGroup,
  type SharedAsset,
} from "../services/sharedLibrary";
import { FeatureDialog } from "./shared";
import type { Asset, AssetCategory, Project } from "../types";
import type { LibraryPreferences } from "../services/libraryPreferences";
import { useSharedLibrary } from "./useSharedLibrary";
import { LibraryNotificationList } from "./LibraryNotificationList";
import { BrowserNotificationSettings } from "./BrowserNotificationSettings";
import "./shared-library.css";

export type SharedLibraryState = ReturnType<typeof useSharedLibrary>;
export function SharedLibraryView({
  library,
  project,
  display,
  clientId,
  updatesOnly,
  onAdd,
  notify,
  notificationsEnabled,
  onNotificationsChange,
}: {
  library: SharedLibraryState;
  project?: Project;
  display: LibraryPreferences;
  clientId: string;
  updatesOnly: boolean;
  onAdd: (
    files: File[],
    origins: {
      hash: string;
      libraryId: string;
      assetId: string;
      revision: string;
      category: AssetCategory;
    }[],
  ) => Promise<void>;
  notify: (message: string) => void;
  notificationsEnabled: boolean;
  onNotificationsChange: (enabled: boolean) => Promise<void>;
}) {
  const [group, setGroup] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [trash, setTrash] = useState(false);
  const [locate, setLocate] = useState<string[]>();
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(120);
  const [notificationSettingsOpen, setNotificationSettingsOpen] =
    useState(false);
  const [nameEditor, setNameEditor] = useState<string>();
  const [conflictVersions, setConflictVersions] =
    useState<Awaited<ReturnType<typeof sharedConflictVersions>>>();
  const [conflictChoice, setConflictChoice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setSelected([]);
    setPreview(undefined);
    setLocate(undefined);
    setNameEditor(undefined);
    setConflictVersions(undefined);
    setError("");
    setLimit(120);
  }, [updatesOnly, library.connection?.id]);
  const assets = library.snapshot?.assets || [];
  const defaultGroups = [
    { id: "uncategorized", label: "未分类", Icon: Tray }, { id: "all", label: "全部", Icon: GridFour },
    { id: "product", label: "产品", Icon: Package }, { id: "character", label: "角色", Icon: User },
    { id: "scene", label: "场景", Icon: Mountains }, { id: "video", label: "视频", Icon: PlayCircle },
    { id: "audio", label: "音频", Icon: MusicNotes }, { id: "other", label: "其他", Icon: SquaresFour },
    ...(assets.some(a => a.group === "storyboard") ? [{ id: "storyboard", label: "分镜", Icon: FilmStrip }] : []),
  ];
  const defaultFolderGroups = new Map(defaultGroups.filter(item => item.id !== "all").map(item => [item.label, item.id]));
  const folderNames = [...new Set([...(library.snapshot?.folders || []), ...assets.map((asset) => asset.sourceFolder).filter((name): name is string => !!name)])]
    .filter(name => name.trim() !== "道具" && !defaultFolderGroups.has(name.trim()))
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
  const selectedGroup = libraryGroups.find((item) => item.id === group);
  const shown = assets.filter(
    (asset) =>
      Boolean(asset.trashedAt) === trash &&
      (group === "all" || (group.startsWith("folder:")
        ? asset.sourceFolder === group.slice(7)
        : group === "uncategorized" ? asset.sourceFolder?.trim() === "道具" || (defaultFolderGroups.get(asset.sourceFolder?.trim() || "") || (asset.group === "prop" ? "uncategorized" : asset.group)) === "uncategorized"
        : (defaultFolderGroups.get(asset.sourceFolder?.trim() || "") || asset.group) === group && asset.sourceFolder?.trim() !== "道具")) &&
      asset.name.toLowerCase().includes(search.toLowerCase()) &&
      (!locate || locate.includes(asset.id)),
  );
  useOriginalGrid(
    gridRef,
    display.layout === "original" && !updatesOnly,
    shown
      .slice(0, limit)
      .map((asset) => asset.id)
      .join(","),
  );
  const work = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      await library.refresh();
      setBusy(false);
    }
  };
  const selectedAssets = assets.filter((asset) => selected.includes(asset.id));
  const change = (patch: { group?: LibraryGroup; trashedAt?: string | null }) =>
    work(async () => {
      if (!library.connection) return;
      let saved = 0;
      try {
        for (const asset of selectedAssets) {
          const result = await editSharedAsset(
            library.connection.handle,
            clientId,
            asset,
            patch,
          );
          if (result.cleanupWarning) notify(result.cleanupWarning);
          saved++;
        }
        setSelected([]);
      } catch (reason) {
        throw new Error(
          `${saved ? `已保存 ${saved} 项；` : ""}${(reason as Error).message}`,
        );
      }
    });
  const importImages = (files: File[]) =>
    work(async () => {
      if (!library.connection || library.connection.mode === "readonly")
        throw new Error("请先连接可写的 映箱公共库；现有目录仍保持只读");
      if (group === "video" || group === "audio") throw new Error("公共资产库目前只支持图片，请在图片分类下导入。");
      const inputs = [];
      for (const file of files) {
        const input = await imageLibraryInput(file);
        inputs.push(group.startsWith("folder:") ? { ...input, sourceFolder: group.slice(7) } : input);
      }
      const result = await publishToLibrary(
        library.connection.handle,
        clientId,
        inputs,
        selectedGroup?.id,
      );
      notify(
        `公共库已新增 ${result.added} 张图片${result.duplicates ? `，跳过 ${result.duplicates} 张重复图片` : ""}`,
      );
    });
  return (
    <section
      className="assets-workspace public-workspace"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer.types.includes("application/weave-assets")) {
          setError("请在项目中使用「收录到公共库」，可明确确认要公开的图片。");
          return;
        }
        const files = Array.from(event.dataTransfer.files);
        if (files.length) void importImages(files);
        else setError("网页链接不能直接保存到公共库，请先下载原图再拖入。");
      }}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.files);
        if (files.length) {
          event.preventDefault();
          event.stopPropagation();
          void importImages(files);
        }
      }}
    >
      <div className="public-heading">
        <div>
          <h2>{updatesOnly && !locate ? "通知" : "公共资产库"}</h2>
          <p>
            {library.connection
              ? `${library.connection.name}${library.connection.mode === "readonly" ? " · 只读关联" : " · 共享文件夹"}`
              : updatesOnly
                ? "公共素材库的新增记录"
                : "产品、角色、场景 · 与本地项目独立"}
            {library.connection &&
              ` · ${library.error ? "同步暂停" : library.checkedAt ? `已检查 ${new Date(library.checkedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : "正在检查目录"}`}
          </p>
        </div>
        <div className="heading-actions">
          {updatesOnly && (
            <button onClick={() => setNotificationSettingsOpen(true)}>
              <Bell size={16} />
              系统提醒
            </button>
          )}
          {library.connection?.mode === "managed" && !updatesOnly && (
            <button
              disabled={busy || library.busy}
              onClick={() => fileInput.current?.click()}
            >
              <Plus size={16} />
              导入图片
            </button>
          )}
          {library.connection && (
            <>
              <button
                onClick={() => void library.authorize()}
                disabled={busy || library.busy}
              >
                重新授权
              </button>
              <button
                title="刷新公共库"
                aria-label="刷新公共库"
                disabled={library.refreshing}
                onClick={() => void library.refresh()}
              >
                <ArrowsClockwise size={17} />
              </button>
            </>
          )}
          <details className="public-connect">
            <summary>
              <FolderOpen size={16} />
              {library.connection ? "更换共享文件夹" : "连接共享文件夹"}
            </summary>
            <div>
              <button
                disabled={library.busy || busy}
                onClick={() => void library.connect("managed")}
              >
                选择共享文件夹（可编辑）
              </button>
              <p className="feature-note">同事选择同一个共享文件夹。首次连接会创建管理文件并复制收录已有图片；原图保留，软件内操作不会同步修改这些原图。</p>
              {library.connection && (
                <button onClick={() => void library.disconnect()}>
                  断开连接（不删文件）
                </button>
              )}
            </div>
          </details>
        </div>
      </div>
      {(error || library.error) && (
        <p role="alert" className="public-error">
          {error || library.error}
        </p>
      )}
      {library.snapshot?.warnings.map((message) => (
        <p className="public-error" key={message}>
          {message}
        </p>
      ))}
      {library.delivery && (
        <p className="feature-note notice-delivery" role="status">
          {library.delivery}
        </p>
      )}
      {updatesOnly && !locate ? (
        <LibraryNotificationList
          notices={library.notices}
          assets={assets}
          connected={!!library.connection}
          loading={library.refreshing}
          onRead={library.markRead}
          onOpen={(update) => {
            library.markRead(update.entryIds);
            setGroup("all");
            setTrash(false);
            setSearch("");
            setLimit(120);
            setLocate(update.assetIds);
            setSelected(update.assetIds);
          }}
        />
      ) : (
        <>
          <div className="library-controls public-library-controls">
            <div className="public-category-rows">
            <div className="category-tabs library-category-tabs">
              {defaultGroups.map((item) => (
                <button
                  key={item.id}
                  className={`${group === item.id ? "active" : ""} ${item.id === "all" ? "category-divider-after" : ""}`}
                  data-category={item.id === "all" ? undefined : item.id}
                  style={item.id === "all" ? undefined : assetCategoryStyle(item.id)}
                  aria-pressed={group === item.id}
                  title={item.id === "video" || item.id === "audio" ? "公共资产库目前只支持图片" : `查看${item.label}`}
                  onClick={() => {
                    setGroup(item.id);
                    setSelected([]);
                    setLimit(120);
                  }}
                >
                  <item.Icon size={14} aria-hidden="true" />{item.label}
                </button>
              ))}
            </div>
            {folderNames.length > 0 && <div className="public-folder-row"><span>文件夹</span><div className="category-tabs public-folder-tabs">
              {folderNames.map(name => <button key={name} type="button" className={group === `folder:${name}` ? "active" : ""} aria-pressed={group === `folder:${name}`} onClick={() => { setGroup(`folder:${name}`); setSelected([]); setLimit(120); }}><FolderOpen size={14} />{name}</button>)}
            </div></div>}
            </div>
            <div className="toolbar-controls">
              <input
                aria-label="搜索公共素材"
                placeholder="搜索公共素材"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setLimit(120);
                }}
              />
              <button
                onClick={() => {
                  setTrash(!trash);
                  setSelected([]);
                }}
              >
                {trash ? "返回资产库" : "回收站"}
              </button>
            </div>
          </div>
          {locate && (
            <div className="public-update-actions">
              <button
                onClick={() => {
                  setLocate(undefined);
                  setSelected([]);
                }}
              >
                返回通知
              </button>
            </div>
          )}
          <div className="library-scroll">
            {!shown.length && (
              <div className="empty-state">
                <FolderOpen size={32} />
                <h2>
                  {locate
                    ? "这些素材暂不可查看"
                    : group === "video" || group === "audio" ? "公共库暂无此类型素材" : library.connection
                      ? "这里还没有素材"
                      : "连接公共资产库"}
                </h2>
                <p>
                  {locate
                    ? "可能已移入回收站或目录暂不可访问，通知记录会保留。"
                    : group === "video" || group === "audio" ? "公共资产库目前只支持图片，视频和音频请保存在项目中。" : library.connection
                      ? "在本地项目中选中图片，点击「收录到公共库」。"
                      : "选择共享文件夹；同事连接同一个文件夹即可一起管理图片。"}
                </p>
              </div>
            )}
            <div
              className={`asset-grid ${display.density} layout-${display.layout}`}
              ref={gridRef}
            >
              {shown.slice(0, limit).map((asset) => (
                <AssetThumb
                  key={asset.id}
                  asset={{ ...asset, category: asset.group === "prop" || asset.sourceFolder === "道具" ? "uncategorized" : asset.group === "product" ? "product" : asset.category }}
                  display={display}
                  selected={selected.includes(asset.id)}
                  canPreview={!trash && !!asset.url}
                  copyDisabled={busy}
                  onSelect={(event) =>
                    setSelected(
                      event.ctrlKey || event.metaKey
                        ? selected.includes(asset.id)
                          ? selected.filter((id) => id !== asset.id)
                          : [...selected, asset.id]
                        : [asset.id],
                    )
                  }
                  onToggle={() =>
                    setSelected(
                      selected.includes(asset.id)
                        ? selected.filter((id) => id !== asset.id)
                        : [...selected, asset.id],
                    )
                  }
                  onPreview={() => setPreview(asset.id)}
                  onCopy={(image) =>
                    void copyAssetImage(image)
                      .then(() => notify("完整图片已复制"))
                      .catch((reason) => setError((reason as Error).message))
                  }
                />
              ))}
            </div>
            {shown.length > limit && (
              <button
                className="public-more"
                onClick={() => setLimit(limit + 120)}
              >
                继续显示（{Math.min(limit, shown.length)} / {shown.length}）
              </button>
            )}
          </div>
          {selected.length > 0 && (
            <div className="selection-toolbar">
              <strong>已选 {selected.length} 项</strong>
              {selectedAssets.length === 1 && selectedAssets[0].conflict && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void work(async () => {
                      if (!library.connection) return;
                      const versions = await sharedConflictVersions(
                        library.connection.handle,
                        selectedAssets[0].id,
                      );
                      setConflictVersions(versions);
                      setConflictChoice(versions[0]?.head || "");
                    })
                  }
                >
                  解决冲突
                </button>
              )}
              {!trash && (
                <button
                  disabled={
                    busy ||
                    !project ||
                    selectedAssets.some((asset) => asset.conflict)
                  }
                  onClick={() =>
                    void work(async () => {
                      if (!library.connection || !project) return;
                      const files: File[] = [],
                        origins: {
                          hash: string;
                          libraryId: string;
                          assetId: string;
                          revision: string;
                          category: AssetCategory;
                        }[] = [];
                      for (const asset of selectedAssets) {
                        const blob = asset.external
                          ? await readDiskFile(
                              library.connection.handle,
                              asset.relativePath,
                            )
                          : await sharedAssetBlob(
                              library.connection.handle,
                              asset,
                            );
                        const hash = await hashBlob(blob);
                        files.push(
                          new File([blob], asset.name, { type: asset.mime }),
                        );
                        origins.push({
                          hash,
                          libraryId: asset.libraryId,
                          assetId: asset.id,
                          revision: asset.head,
                          category: asset.group === "prop" || asset.sourceFolder === "道具" ? "uncategorized" : asset.group === "product" ? "product" : asset.category,
                        });
                      }
                      await onAdd(files, origins);
                      notify(
                        `已复制到本地项目「${projectLabel(project)}」，公共原片保留`,
                      );
                      setSelected([]);
                    })
                  }
                >
                  <ArrowDown size={16} />
                  加入当前项目
                  {project ? ` · ${projectLabel(project)}` : "（先选择项目）"}
                </button>
              )}
              {library.connection?.mode !== "readonly" && (
                <>
                  {!trash && selectedAssets.length === 1 && (
                    <button
                      disabled={busy || !!selectedAssets[0].conflict}
                      onClick={() => setNameEditor(selectedAssets[0].name)}
                    >
                      改名
                    </button>
                  )}
                  {!trash && (
                    <select
                      aria-label="整理公共素材分类"
                      disabled={busy}
                      value=""
                      onChange={(event) =>
                        void change({
                          group: event.target.value as LibraryGroup,
                        })
                      }
                    >
                      <option value="">归类到…</option>
                      {libraryGroups.filter((item) => item.id !== "prop").map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    disabled={busy}
                    onClick={() =>
                      void change({
                        trashedAt: trash ? null : new Date().toISOString(),
                      })
                    }
                  >
                    {trash ? (
                      <ArrowCounterClockwise size={16} />
                    ) : (
                      <Trash size={16} />
                    )}
                    {trash ? "恢复素材" : "移入回收站"}
                  </button>
                </>
              )}
              <button onClick={() => setSelected([])}>取消选择</button>
            </div>
          )}
        </>
      )}
      {preview && (
        <AssetPreview
          assets={shown}
          initialId={preview}
          shots={[]}
          onClose={() => setPreview(undefined)}
          readOnly
          onUpdate={async () => {
            throw new Error("请通过公共库分类操作整理素材");
          }}
          onReveal={(asset) => {
            const link = document.createElement("a");
            link.href = asset.url || "";
            link.download = asset.name;
            link.click();
          }}
          onReadDocument={async () => ""}
        />
      )}
      <input
        type="file"
        multiple
        accept=".png,.jpg,.jpeg,.webp,.avif,.gif,.bmp"
        ref={fileInput}
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          event.target.value = "";
          if (files.length) void importImages(files);
        }}
      />
      {nameEditor !== undefined && (
        <FeatureDialog
          title="公共素材改名"
          busy={busy}
          onClose={() => setNameEditor(undefined)}
        >
          <form
            className="feature-fields"
            onSubmit={(event) => {
              event.preventDefault();
              void work(async () => {
                if (!library.connection || selectedAssets.length !== 1) return;
                await editSharedAsset(
                  library.connection.handle,
                  clientId,
                  selectedAssets[0],
                  { name: nameEditor },
                );
                setNameEditor(undefined);
              });
            }}
          >
            <label>
              文件名（保留图片扩展名）
              <input
                required
                value={nameEditor}
                onChange={(event) => setNameEditor(event.target.value)}
              />
            </label>
            <p className="feature-note">
              名称会同步到实际文件夹，历史原片保留。
            </p>
            {error && (
              <p className="feature-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="feature-primary"
              disabled={busy || !nameEditor.trim()}
            >
              保存
            </button>
          </form>
        </FeatureDialog>
      )}
      {conflictVersions && (
        <FeatureDialog
          title="选择保留的公共素材版本"
          busy={busy}
          onClose={() => setConflictVersions(undefined)}
        >
          <form
            className="feature-fields"
            onSubmit={(event) => {
              event.preventDefault();
              void work(async () => {
                if (!library.connection || !conflictVersions.length) return;
                await resolveSharedConflict(
                  library.connection.handle,
                  clientId,
                  conflictVersions[0].entry.id,
                  conflictChoice,
                  conflictVersions.map((version) => version.head),
                );
                setConflictVersions(undefined);
                setSelected([]);
                notify("已合并冲突，历史提交与原片保留");
              });
            }}
          >
            <p className="feature-note">
              选择要使用的名称和分类。其他版本的记录和原片不会永久删除。
            </p>
            {conflictVersions.map((version) => (
              <label className="feature-check" key={version.head}>
                <input
                  type="radio"
                  name="conflict-version"
                  value={version.head}
                  checked={conflictChoice === version.head}
                  onChange={() => setConflictChoice(version.head)}
                />
                {version.entry.name} ·{" "}
                {
                  libraryGroups.find(
                    (group) => group.id === version.entry.group,
                  )?.label
                }{" "}
                · {new Date(version.entry.updatedAt).toLocaleString("zh-CN")}
              </label>
            ))}
            {error && (
              <p className="feature-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="feature-primary"
              disabled={busy || !conflictChoice}
            >
              保留所选版本并合并
            </button>
          </form>
        </FeatureDialog>
      )}
      {notificationSettingsOpen && (
        <FeatureDialog
          title="系统提醒"
          onClose={() => setNotificationSettingsOpen(false)}
        >
          <div className="notification-settings-content">
            <BrowserNotificationSettings
              enabled={notificationsEnabled}
              onChange={onNotificationsChange}
              immediate
            />
          </div>
        </FeatureDialog>
      )}
    </section>
  );
}
