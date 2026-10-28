import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bell,
  Check,
  FolderOpen,
  FolderSimple,
  Gear,
  GridFour,
  Plus,
  Stack,
  Trash,
  UsersThree,
  UploadSimple,
  X,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import { useWorkspace } from "./store";
import { projectLabel } from "../shared/workspace-labels.mjs";
import {
  isDesktop,
  invoke,
  onChanged,
  prepareFiles,
  prepareRemote,
  supportedFile,
} from "./services/api";
import { renderStoryboard } from "./services/storyboard";
import type { Asset, AssetCategory } from "./types";
import {
  LIBRARY_PREFERENCES_KEY,
  parseLibraryPreferences,
  readLibraryPreferences,
  type LibraryPreferences,
} from "./services/libraryPreferences";
import { AssetsView } from "./components/AssetsView";
import { ProjectHome } from "./components/ProjectHome";
import { EditingWorkspace } from "./features/EditingWorkspace";
import { hashBlob } from "./services/directoryFiles";
import { AssetPreview } from "./features/AssetPreview";
import { SettingsDialog } from "./features/SettingsDialog";
import { ExportDialog } from "./features/ExportDialog";
import { AssetOutboundDialog } from "./features/AssetOutboundDialog";
import { copyAssetImage } from "./services/assetOutbound";
import { bindDragCleanup } from "./services/dragLifecycle";
import { droppedMediaUrl } from "./services/assetDrop";
import { useSharedLibrary } from "./features/useSharedLibrary";
import { SharedLibraryView } from "./features/SharedLibraryView";
import { LocalFolderSettings } from "./features/LocalFolderSettings";
import { QuickPreview, useQuickPreview } from "./features/QuickPreview";
import { useImportNaming } from "./features/ImportNaming";
import { expandStackIds, type StackAction } from "../shared/asset-stacks.mjs";
import { useProjectFolderSync } from "./features/useProjectFolderSync";
import { attachProjectFolder } from "./services/folderBrowser";
import { pickDirectory } from "./services/directoryFiles";
import type { PreparedProjectArchive } from "./services/projectArchive";
import { installBrowserProject } from "./services/browserRepository";
import { StorageNotice } from "./features/StorageNotice";
import { useSaveStatus } from "./features/useSaveStatus";
import "./features/workflow.css";
import { readResume, writePreference } from "./services/workspacePreferences";
import type { BackupInfo } from "./services/projectArchive";
import { PublishToLibraryDialog } from "./features/PublishToLibraryDialog";
import { folderConnections } from "./services/folderConnections";
import "./features/features.css";

type View = "projects" | "library" | "shots" | "activity" | "trash" | "public";
export function App() {
  const saveStatus = useSaveStatus();
  const {
    projects,
    snapshot,
    settings,
    loading,
    busy,
    error,
    warning,
    refresh,
    run,
    clearError,
  } = useWorkspace();
  const [view, setViewState] = useState<View>("library");
  const [visitedShots, setVisitedShots] = useState(false);
  const canLeaveEditing = () => {
    const dirty = document.querySelector(
      '.workspace-view-cache > div:not([hidden]) [data-editing-dirty="true"]',
    );
    return !dirty || window.confirm(
      "当前有未保存的文字、批注或画布内容。切换后仍会保留在当前项目；如果接着切换项目，未保存内容可能丢失。确定切换？",
    );
  };
  const setView = (next: View) => {
    if (next !== view && canLeaveEditing()) {
      setSelection([]);
      if (next === "shots") setVisitedShots(true);
      setViewState(next);
    }
  };
  const [selection, setSelection] = useState<string[]>([]);
  const [filter, setFilter] = useState<AssetCategory | "all">("all");
  const [search, setSearch] = useState("");
  const [previewId, setPreviewId] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectRootName, setProjectRootName] = useState("");
  useEffect(() => {
    void folderConnections()
      .then((items) =>
        setProjectRootName(
          items.find((item) => item.kind === "project-root")?.name || "",
        ),
      )
      .catch(() => {});
  }, [settingsOpen]);
  const [exportOpen, setExportOpen] = useState(false);
  const [outboundAssets, setOutboundAssets] = useState<Asset[]>([]);
  const [publishAssets, setPublishAssets] = useState<Asset[]>([]);
  const sharedLibrary = useSharedLibrary(
    settings.deviceId || "",
    !isDesktop || settings.notifications,
    () => setView("activity"),
  );
  const quickPreview = useQuickPreview([
    ...(snapshot?.assets || []),
    ...(sharedLibrary.snapshot?.assets || []),
  ]);
  const importNaming = useImportNaming();
  const [newProject, setNewProject] = useState<string | undefined>();
  const [toast, setToast] = useState("");
  const notify = useCallback((message: string) => setToast(message), []);
  const [dragging, setDragging] = useState(false);
  const dragExpiry = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const resetDragging = useCallback(() => {
    clearTimeout(dragExpiry.current);
    setDragging(false);
  }, []);
  useEffect(() => {
    const unbind = bindDragCleanup(window, resetDragging);
    return () => {
      unbind();
      clearTimeout(dragExpiry.current);
    };
  }, [resetDragging]);
  useEffect(resetDragging, [view, filter, resetDragging]);
  const [urlOpen, setUrlOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [urlCategory, setUrlCategory] = useState<AssetCategory>();
  const [urlTarget, setUrlTarget] = useState<{
    projectId: string;
    category: AssetCategory;
  }>();
  const [libraryDisplay, setLibraryDisplay] = useState(() => {
    try {
      return readLibraryPreferences((key) => localStorage.getItem(key));
    } catch {
      return parseLibraryPreferences(null);
    }
  });
  const changeLibraryDisplay = (patch: Partial<LibraryPreferences>) =>
    setLibraryDisplay((previous) => ({ ...previous, ...patch }));
  useEffect(() => {
    try {
      localStorage.setItem(
        LIBRARY_PREFERENCES_KEY,
        JSON.stringify(libraryDisplay),
      );
    } catch {}
  }, [libraryDisplay]);
  const fileInput = useRef<HTMLInputElement>(null),
    folderInput = useRef<HTMLInputElement>(null);
  const projectId = snapshot?.project.id;
  const [resumedProject, setResumedProject] = useState("");
  useEffect(() => {
    if (!projectId) return;
    const resume = readResume(projectId);
    setViewState(resume.view);
    if (resume.view === "shots") setVisitedShots(true);
    setSearch(resume.search);
    setFilter(resume.filter as AssetCategory | "all");
    setResumedProject(projectId);
  }, [projectId]);
  useEffect(() => {
    if (!projectId || resumedProject !== projectId || !["library", "shots"].includes(view)) return;
    writePreference(`weave.resume.${projectId}`, { view, search, filter });
  }, [projectId, resumedProject, view, search, filter]);
  const listProjectBackups = useCallback(
    async () => (await invoke("listProjectBackups", { projectId })) as BackupInfo[],
    [projectId],
  );
  const createProjectBackup = useCallback(
    async () => {
      const result = (await run("createProjectBackup", { projectId })) as BackupInfo;
      writePreference(`weave.last-backup.${projectId}`, { createdAt: result.createdAt, assetCount: result.assetCount });
      return result;
    },
    [run, projectId],
  );
  const restoreProjectBackup = useCallback(async (backupId: string) => {
    const result = await run("restoreProjectBackup", { projectId, backupId });
    if (!result?.canceled) {
      setSettingsOpen(false);
      setViewState("projects");
      notify(`已恢复为独立项目「${result.project?.name || "恢复副本"}」，原项目和备份均保留。`);
    }
    return result;
  }, [run, projectId, notify]);
  const folderSync = useProjectFolderSync(
    projectId,
    snapshot?.project.root.startsWith("directory:") || false,
  );
  const attempt = useCallback(
    async (work: () => Promise<any>, message?: string) => {
      try {
        const result = await work();
        if (message && !result?.canceled) notify(message);
        return result;
      } catch (e) {
        notify((e as Error).message || "操作失败，请重试");
      }
    },
    [notify],
  );

  useEffect(() => {
    refresh().catch(() => {});
    return onChanged((event) => {
      if (!document.querySelector('[data-editing-dirty="true"]'))
        refresh().catch(() => {});
      if (event?.reason === "notification") setView("activity");
      if (event?.reason === "inbox.error")
        notify(
          event.message ||
            "自动接收失败，请检查接收目录和项目是否可访问。原文件没有删除。",
        );
    });
  }, [refresh, notify]);
  useEffect(() => {
    const unsubscribe = window.weaveDesktop?.onUpdate((status) => {
      if (status?.state === "downloaded")
        notify(`映箱 ${status.version} 更新包已下载并校验，请关闭软件后按提示替换程序文件。`);
      else if (status?.state === "error")
        notify(status.message || "映箱自动更新失败，可在设置中重新检查。旧版本未受影响。");
    });
    return unsubscribe;
  }, [notify]);
  useEffect(() => {
    setSelection([]);
    setPreviewId("");
  }, [projectId, view]);
  useEffect(() => setOutboundAssets([]), [projectId]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (snapshot)
      setSelection((previous) =>
        previous.filter((id) => snapshot.assets.some((a) => a.id === id)),
      );
  }, [snapshot]);

  const selectProject = async (id: string) => {
    if (!canLeaveEditing()) return;
    await run("selectProject", { id });
    if (settings.receiveProjectId)
      await run("saveSettings", {
        patch: { receiveProjectId: "", receiveShotId: "" },
      });
  };
  const restoreProjectArchive = async ({ record, media }: PreparedProjectArchive) => {
    if (isDesktop) throw new Error("桌面版请先解压备份，再用“打开项目文件夹”导入。");
    const restored = structuredClone(record);
    const id = crypto.randomUUID();
    const originalName = restored.project.name.trim().replace(/(?:（恢复(?: \d+)?）)+$/u, "");
    let name = `${originalName}（恢复）`;
    let suffix = 2;
    while (projects.some(project => project.name === name)) name = `${originalName}（恢复 ${suffix++}）`;
    restored.project = { ...restored.project, id, name, root: `indexeddb://${id}`, createdAt: new Date().toISOString() };
    restored.publicInbox = false;
    await installBrowserProject(restored, media, true);
    await run("selectProject", { id });
    setViewState("library");
    notify(`已恢复为独立项目「${name}」，原项目和备份均未覆盖。`);
    await refresh();
  };
  const receivingId = projectId || "";
  const requireReceivingProject = (id?: string) => {
    if (!id) throw new Error("请先选择或新建项目，再导入素材。");
    return id;
  };
  const importFiles = async (
    files: File[],
    category?: AssetCategory,
    target?: { projectId: string; shotId?: string; stackTargetId?: string },
  ) => {
    if (!files.length) return;
    const accepted = files.filter(
      (file) => supportedFile(file) || (isDesktop && !file.type),
    );
    if (!accepted.length) throw new Error("这批文件没有支持的图片、视频或文档");
    const targetId = requireReceivingProject(target?.projectId || receivingId);
    if (isDesktop && target?.stackTargetId)
      throw new Error(
        "请先导入视频，再把已有视频卡片拖到一起；本次未导入或移动文件",
      );
    const destination = category ?? (!target && view === "library" && filter !== "all" ? filter : "uncategorized");
    const named = await importNaming.prepare(accepted);
    if (!named) return;
    const prepared = await prepareFiles(named);
    const result = await run("importFiles", {
      projectId: targetId,
      ...prepared,
      category: destination,
      ...(target?.stackTargetId
        ? {
            stackTargetId: target.stackTargetId,
            revisions: Object.fromEntries(
              (snapshot?.assets || []).map((asset) => [
                asset.id,
                asset.revision,
              ]),
            ),
          }
        : {}),
      shotId: target?.shotId || "",
    });
    if (targetId !== projectId) await selectProject(targetId);
    else if (!target) setView("library");
    const duplicates =
      result?.duplicates?.length ?? result?.duplicateCount ?? 0;
    notify(
      duplicates
        ? `导入完成，跳过 ${duplicates} 个重复文件${result?.linkedCount ? `，${result.linkedCount} 项已关联接收镜头` : ""}${result?.trashedDuplicateCount ? "（回收站中的重复素材可恢复）" : ""}`
        : `素材已保存到项目${accepted.length < files.length ? `，跳过 ${files.length - accepted.length} 个不支持的文件` : ""}`,
    );
    const latest = useWorkspace.getState().snapshot;
    return latest?.project.id === targetId
      ? latest.assets.filter(a => !a.trashedAt &&
          (result?.assets?.some((item: Asset) => item.id === a.id) ||
           result?.duplicates?.some((item: { id?: string }) => item.id === a.id) ||
           isDesktop && !snapshot?.assets.some(item => item.id === a.id))).map(a => a.id)
      : [];
  };
  const pickFiles = () =>
    attempt(async () => {
      const targetId = requireReceivingProject(receivingId);
      if (!isDesktop) {
        fileInput.current?.click();
        return;
      }
      const result = await run("pickFiles", {
        projectId: targetId,
        shotId: "",
      });
      if (!result?.canceled) {
        await selectProject(targetId);
        notify("素材已保存到项目");
      }
    });
  const updateAssets = async (ids: string[], patch: Partial<Asset>) => {
    if (!projectId || !ids.length) return;
    if (patch.category) ids = expandStackIds(ids, snapshot!.assets);
    const revisions = Object.fromEntries(
      snapshot!.assets.map((a) => [a.id, a.revision]),
    );
    await run("updateAssets", { projectId, ids, patch, revisions });
  };
  const editAssetStack = async (action: StackAction) => {
    if (!projectId || !snapshot) return;
    await run("editAssetStack", {
      projectId,
      action,
      revisions: Object.fromEntries(
        snapshot.assets.map((asset) => [asset.id, asset.revision]),
      ),
    });
    setSelection([]);
  };
  const trashSelected = (ids = selection) =>
    attempt(async () => {
      if (!ids.length || !projectId) return;
      await run("trashAssets", {
        projectId,
        ids,
        revisions: Object.fromEntries(
          snapshot!.assets
            .filter((a) => ids.includes(a.id))
            .map((a) => [a.id, a.revision]),
        ),
      });
      setSelection([]);
      notify("已移入回收站，原文件仍可恢复");
    });
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.closest('input,textarea,[contenteditable="true"]') ||
        settingsOpen ||
        exportOpen ||
        newProject !== undefined ||
        previewId ||
        outboundAssets.length > 0 ||
        publishAssets.length > 0 ||
        document.querySelector("dialog[open]") ||
        view === "public" ||
        view === "activity" ||
        view === "shots"
      )
        return;
      const files = Array.from(event.clipboardData?.files || []);
      if (files.length) {
        event.preventDefault();
        attempt(() => importFiles(files));
        return;
      }
      const text = event.clipboardData?.getData("text/plain")?.trim() || "";
      const html = event.clipboardData?.getData("text/html") || "";
      const imageUrl = html
        ? new DOMParser()
            .parseFromString(html, "text/html")
            .querySelector("img")?.src
        : "";
      if (imageUrl || /^https?:\/\/\S+$/.test(text)) {
        event.preventDefault();
        setUrl(imageUrl || text);
        setUrlTarget(undefined);
        setUrlCategory(view === "library" && filter !== "all" ? filter : undefined);
        setUrlOpen(true);
      }
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  });
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement).closest(
          'input,textarea,select,button,summary,dialog,[contenteditable="true"]',
        ) ||
        settingsOpen ||
        exportOpen ||
        newProject !== undefined ||
        previewId ||
        outboundAssets.length > 0 ||
        publishAssets.length > 0 ||
        view === "public" ||
        view === "activity"
      )
        return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        document
          .querySelector<HTMLInputElement>('input[aria-label="搜索素材"]')
          ?.focus();
      }
      if (event.code === "Space" && selection[0]) {
        event.preventDefault();
        const asset = snapshot?.assets.find(
          (asset) => asset.id === selection[0],
        );
        if (asset) quickPreview.open(asset);
      }
      if (event.key === "Escape") setSelection([]);
      if (event.key === "Delete" && view === "library") {
        event.preventDefault();
        trashSelected();
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  });
  const unread = sharedLibrary.unread;
  const previewAssets =
    snapshot?.assets.filter(
      (a) =>
        !a.trashedAt &&
        (selection.includes(previewId) && selection.length > 1
          ? selection.includes(a.id)
          : true),
    ) || [];
  const receiver = projects.find((p) => p.id === receivingId);
  const activeCount = snapshot?.assets.filter((a) => !a.trashedAt).length || 0;
  const transferProps = {
    projects,
    currentProjectId: projectId || "",
    onImportCategory: (files: File[], category: AssetCategory) => {
      setDragging(false);
      attempt(async () => {
        const importedIds = await importFiles(
          files,
          category,
          projectId ? { projectId, shotId: "" } : undefined,
        );
        // Re-apply the drop destination after the naming/import round-trip.
        // This makes the intended category authoritative even when a duplicate
        // or a folder-backed import refreshes the snapshot during the dialog.
        const latest = useWorkspace.getState().snapshot;
        if (importedIds?.length && latest && latest.project.id === projectId) {
          await run("updateAssets", {
            projectId,
            ids: importedIds,
            patch: { category },
            revisions: Object.fromEntries(latest.assets.map((asset) => [asset.id, asset.revision])),
          });
        }
      });
    },
    onImportLink: (link: string, category: AssetCategory) => {
      setDragging(false);
      if (projectId) setUrlTarget({ projectId, category });
      setUrl(link);
      setUrlOpen(true);
    },
    display: libraryDisplay,
    onDisplayChange: changeLibraryDisplay,
    onTrashIds: (ids: string[]) => trashSelected(ids),
    onRename: async (ids: string[], prefix: string) => {
      if (/[\\/:*?"<>|]/.test(prefix))
        throw new Error("名称不能包含路径或特殊字符");
      for (const [index, id] of ids.entries()) {
        const asset = snapshot?.assets.find((a) => a.id === id);
        if (!asset) continue;
        const dot = asset.name.lastIndexOf(".");
        await updateAssets([id], {
          name: `${prefix}_${String(index + 1).padStart(3, "0")}${dot >= 0 ? asset.name.slice(dot) : ""}`,
        });
      }
      notify("素材名称已保存");
    },
    onTransfer: (targetProjectId: string) =>
      attempt(async () => {
        await run("transferAssets", {
          projectId,
          ids: selection,
          targetProjectId,
          move: !!snapshot?.project.publicInbox,
          revisions: Object.fromEntries(
            (snapshot?.assets || [])
              .filter((a) => selection.includes(a.id))
              .map((a) => [a.id, a.revision]),
          ),
        });
        setSelection([]);
        notify("素材已加入所选项目");
      }),
  };
  let content;
  if (loading)
    content = (
      <div className="empty-state">
        <div className="loader" />
        <p>正在读取工作区…</p>
      </div>
    );
  else if (view === "public" || view === "activity")
    content = (
      <SharedLibraryView
        key={`${sharedLibrary.connection?.id || "none"}:${view}`}
        library={sharedLibrary}
        project={snapshot?.project}
        display={libraryDisplay}
        clientId={settings.deviceId || ""}
        notificationsEnabled={!isDesktop || settings.notifications}
        onNotificationsChange={async (enabled) => {
          await run("saveSettings", { patch: { notifications: enabled } });
        }}
        updatesOnly={view === "activity"}
        notify={notify}
        onAdd={async (files, origins) => {
          if (!projectId) throw new Error("请先选择本地项目");
          const groups = new Set(origins.map((origin) => origin.category));
          let copied = 0;
          try {
            for (const category of groups) {
              const indices = origins
                .map((origin, index) =>
                  origin.category === category ? index : -1,
                )
                .filter((index) => index >= 0);
              const prepared = await prepareFiles(
                indices.map((index) => files[index]),
              );
              prepared.files.forEach((file, index) => {
                const origin = origins[indices[index]];
                file.source = `公共库:${origin.libraryId}/${origin.assetId}@${origin.revision};SHA256=${origin.hash}`;
              });
              await run("importFiles", { projectId, ...prepared, category });
              copied += indices.length;
            }
          } catch (error) {
            throw new Error(
              `${copied ? `已复制 ${copied} 张；` : ""}${(error as Error).message}`,
            );
          }
        }}
      />
    );
  else if (view === "projects" || !snapshot)
    content = (
      <ProjectHome
        projects={projects}
        desktop={isDesktop}
        folderName={projectRootName}
        onCreate={() => setNewProject("")}
        onOpen={() => {
          if (isDesktop) {
            attempt(async () => {
              const result = await run("openProject");
              if (!result?.canceled) setView("library");
            });
            return;
          }
          const choice = pickDirectory();
          attempt(async () => {
            await attachProjectFolder(await choice);
            await refresh();
            setView("library");
          });
        }}
        onSelect={(id) => attempt(() => selectProject(id))}
        onRestoreArchive={restoreProjectArchive}
      />
    );
  else if (view === "shots" || view === "library" || view === "trash")
    content = null;

  const importControls = <div className="library-import-controls">
    <label className="import-naming-toggle" title="开启后，导入图片时先命名；原始来源文件不改动">
      <input type="checkbox" role="switch" aria-label="导入时命名" checked={importNaming.enabled} onChange={importNaming.toggle} />
      <span>导入时命名</span>
    </label>
    {isDesktop && <button className="watch-status" onClick={() => setSettingsOpen(true)}>{settings.inboxPath ? `监听：${settings.inboxPath}` : "设置下载接收目录"}</button>}
    <button className="primary-button" disabled={busy} onClick={pickFiles}><Plus size={16} />导入素材</button>
    <button title="导入图片、视频或音频直链" aria-label="导入图片、视频或音频直链" onClick={() => { setUrl(""); setUrlTarget(undefined); setUrlCategory(view === "library" && filter !== "all" ? filter : undefined); setUrlOpen(true); }}><ArrowRight size={17} /></button>
    <button title="导入文件夹" aria-label="导入文件夹" disabled={busy} onClick={() => folderInput.current?.click()}><FolderOpen size={17} /></button>
  </div>;
  const cachedWorkspace = snapshot && projectId && !loading ? (
    <div className="workspace-view-cache" hidden={view === "projects" || view === "public" || view === "activity"}>
      <div hidden={view !== "shots" || !visitedShots}>
        {visitedShots && <EditingWorkspace
          key={snapshot.project.id}
          active={view === "shots"}
          snapshot={snapshot}
          projectId={projectId}
          onEdit={async (action, revision) => {
            const result = await run("editReference", { projectId, action, revision });
            return { ...result, editing: useWorkspace.getState().snapshot?.editing };
          }}
          onImport={async (files) => {
            const accepted = files.filter(
              (file) =>
                supportedFile(file) &&
                !/\.(txt|md|json|pdf|docx?)$/i.test(file.name),
            );
            if (!accepted.length || accepted.length !== files.length)
              throw new Error(
                "这里只关联图片、视频或音频，请移除不支持的文件后重试",
              );
            if (
              accepted.reduce((sum, file) => sum + file.size, 0) >
              300 * 1024 * 1024
            )
              throw new Error("本次素材超过 300 MB，请分批导入");
            return (await importFiles(accepted, "uncategorized", {
              projectId: snapshot.project.id,
              shotId: "",
            })) || [];
          }}
          onStackAction={editAssetStack}
          onPreview={(a) => {
            setSelection([]);
            quickPreview.open(a);
          }}
        />}
      </div>
      <div hidden={view !== "library" && view !== "trash"}>
      <AssetsView
        key={snapshot.project.id}
        active={view === "library" || view === "trash"}
        importControls={importControls}
        {...transferProps}
        canvas={snapshot.canvas}
        onSaveCanvas={(canvas, revision) => run("saveCanvas", { projectId, canvas, revision })}
        onCanvasImport={async (files) => {
          setDragging(false);
          const ids = await importFiles(files, undefined, { projectId: projectId!, shotId: "" });
          return ids ? { ids, assets: useWorkspace.getState().snapshot?.assets || [] } : undefined;
        }}
        onStackAction={editAssetStack}
        onImportStack={(files, target) =>
          attempt(() =>
            importFiles(files, target.category, {
              projectId: projectId!,
              stackTargetId: target.id,
            }),
          )
        }
        onUse={setOutboundAssets}
        onPublish={(assets) => {
          if (
            !sharedLibrary.connection ||
            sharedLibrary.connection.mode === "readonly"
          ) {
            setView("public");
            notify("请先连接可写的映箱公共库；现有目录也可只读关联");
            return;
          }
          setPublishAssets(assets);
        }}
        onCopy={(asset) => {
          void attempt(async () => {
            try {
              await copyAssetImage(asset);
            } catch (reason) {
              if (
                reason instanceof DOMException &&
                reason.name === "NotAllowedError"
              )
                throw new Error(
                  "复制失败：浏览器未允许写入剪贴板。请检查本站权限，或使用下载原文件上传。",
                );
              throw reason;
            }
          }, "完整图片已复制，可到支持图片粘贴的页面按 Ctrl + V");
        }}
        assets={snapshot.assets}
        paragraphs={snapshot.editing?.paragraphs || []}
        onAttachParagraph={(ids, paragraphId) =>
          attempt(async () => {
            await run("editReference", {
              projectId,
              revision: snapshot.editing?.revision || 0,
              action: { type: "link", id: paragraphId, assetIds: ids },
            });
            setSelection([]);
            notify("素材已关联到剪辑段落，原片没有复制");
          })
        }
        selected={selection}
        onSelection={setSelection}
        onPreview={(a) => setPreviewId(a.id)}
        onUpdate={(ids, patch) =>
          attempt(() => updateAssets(ids, patch), "素材信息已保存")
        }
        onTrash={() => trashSelected()}
        onRestore={() =>
          attempt(async () => {
            await run("restoreAssets", {
              projectId,
              ids: selection,
              revisions: Object.fromEntries(
                snapshot.assets
                  .filter((a) => selection.includes(a.id))
                  .map((a) => [a.id, a.revision]),
              ),
            });
            setSelection([]);
          }, "素材已恢复")
        }
        onImport={pickFiles}
        onImportFolder={() => folderInput.current?.click()}
        filter={filter}
        onFilter={(category) => {
          setFilter(category);
          setSelection([]);
        }}
        search={search}
        onSearchChange={setSearch}
        trash={view === "trash"}
        busy={busy}
      />
      </div>
    </div>
  ) : null;

  return (
    <div
      className="app-shell"
      onDragOver={(e) => {
        if (view === "public" || view === "activity" || view === "shots") {
          resetDragging();
          return;
        }
        if (
          e.dataTransfer.types.includes("Files") &&
          !e.dataTransfer.types.includes("application/weave-assets")
        ) {
          e.preventDefault();
          clearTimeout(dragExpiry.current);
          dragExpiry.current = setTimeout(resetDragging, 1200);
          setDragging(
            !(e.target as Element).closest(
              ".category-destinations,.category-tabs,.canvas-workspace",
            ),
          );
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setDragging(false);
      }}
      onDrop={(e) => {
        if (view === "public" || view === "activity" || view === "shots") {
          e.preventDefault();
          setDragging(false);
          return;
        }
        if (e.dataTransfer.types.includes("application/weave-assets")) return;
        e.preventDefault();
        setDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) attempt(() => importFiles(files));
        else {
          const link = droppedMediaUrl(e.dataTransfer);
          if (link) {
            setUrlTarget(undefined);
            setUrlCategory(view === "library" && filter !== "all" ? filter : undefined);
            setUrl(link);
            setUrlOpen(true);
          }
        }
      }}
    >
      {importNaming.dialog}
      {quickPreview.asset && (
        <QuickPreview
          key={quickPreview.asset.id}
          asset={quickPreview.asset}
          onClose={quickPreview.close}
          onDetails={() => {
            setPreviewId(quickPreview.asset!.id);
            quickPreview.close();
          }}
        />
      )}
      <aside className="sidebar">
        <button className="brand" onClick={() => setView("projects")}>
          <span className="brand-symbol">
            <Stack size={23} weight="duotone" />
          </span>
          映箱
        </button>
        <button
          className={`nav-button ${view === "projects" ? "active" : ""}`}
          onClick={() => setView("projects")}
        >
          <FolderSimple size={19} />
          全部项目
        </button>
        <div className="sidebar-label">
          当前项目
          <button aria-label="新建项目" title="新建项目" onClick={() => setNewProject("")}>
            <Plus size={14} />
          </button>
        </div>
        <button
          className="current-project"
          title={projectLabel(snapshot?.project)}
          onClick={() => (snapshot ? setView("library") : setNewProject(""))}
        >
          <strong>{projectLabel(snapshot?.project) || "创建一个项目"}</strong>
        </button>
        <nav>
          {(
            [
              {
                id: "library",
                label: "素材库",
                icon: Stack,
                count: activeCount,
              },
              {
                id: "shots",
                label: "剪辑对照",
                icon: GridFour,
                count: snapshot?.editing?.paragraphs.length,
              },
              { id: "trash", label: "回收站", icon: Trash, count: 0 },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              disabled={!snapshot}
              className={`nav-button ${view === item.id ? "active" : ""}`}
              onClick={() => {
                setView(item.id);
              }}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {!!item.count && <small>{item.count}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <button
          className={`nav-button public-library-nav ${view === "public" ? "active" : ""}`}
          title="团队共用的公共资产库"
          onClick={() => setView("public")}
        >
          <UsersThree size={18} weight="duotone" />
          <span>公共资产库</span>
        </button>
        {projects.some((p) => !p.publicInbox && p.id !== projectId) && <>
        <div className="sidebar-label">其他项目</div>
        <div className="recent-projects">
          {projects
            .filter((p) => !p.publicInbox && p.id !== projectId)
            .slice(0, 8)
            .map((p) => (
              <button
                key={p.id}
                title={p.name}
                onClick={() => attempt(() => selectProject(p.id))}
              >
                <span className="project-dot" />
                <span>{p.name}</span>
              </button>
            ))}
        </div>
        </>}
        <div className="sidebar-bottom">
          <button
            className={`nav-button ${view === "activity" ? "active" : ""}`}
            title="公共素材库的新增记录"
            onClick={() => setView("activity")}
          >
            <Bell size={18} />
            <span>通知</span>
            {!!unread && <small>{unread}</small>}
          </button>
          <button className="nav-button" onClick={() => setSettingsOpen(true)}>
            <Gear size={18} />
            设置
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <FolderSimple size={17} />
            <button onClick={() => setView("projects")}>项目</button>
            {view === "public" || view === "activity" ? (
              <>
                <span>/</span>
                <strong>{view === "public" ? "公共资产库" : "通知"}</strong>
              </>
            ) : (
              snapshot &&
              view !== "projects" && (
                <>
                  <span>/</span>
                  <select
                    className="project-switcher"
                    aria-label="切换当前查看项目"
                    value={projectId}
                    onChange={(event) =>
                      attempt(() => selectProject(event.target.value))
                    }
                  >
                    {projects.map((project) => (
                      <option value={project.id} key={project.id}>
                        {projectLabel(project)}
                      </option>
                    ))}
                  </select>
                </>
              )
            )}
          </div>
          {snapshot && (view === "library" || view === "trash") && (
            <label className="search topbar-search">
              <MagnifyingGlass size={16} />
              <input
                aria-label="搜索素材"
                placeholder="搜索名称、标签、提示词…"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setSelection([]);
                }}
              />
              <kbd>Ctrl F</kbd>
            </label>
          )}
          <div className="topbar-actions">
            {!isDesktop && <StorageNotice project={snapshot?.project} status={folderSync.status} onBackup={() => setExportOpen(true)} />}
            <button
              className="activity-button"
              title="通知"
              onClick={() => {
                setView("activity");
              }}
            >
              <Bell size={18} />
              {!!unread && <i />}
            </button>
            {snapshot && view !== "public" && view !== "activity" && (
              <button onClick={() => setExportOpen(true)}>
                <UploadSimple size={16} />
                备份与导出
              </button>
            )}
          </div>
        </header>
        {(error || warning) && (
          <div className="error-banner">
            <span>{error || warning}</span>
            <button onClick={clearError} title="关闭">
              <X size={16} />
            </button>
          </div>
        )}
        {cachedWorkspace}
        {content}
        <footer className="workspace-footer">
          <span>
            {saveStatus.failed ? "自动保存失败 · 编辑内容仍保留" : busy ? "正在保存…" : saveStatus.pending ? "有内容尚未保存" : error ? "操作未完成 · 请查看提示" : warning ? "保存位置需确认 · 请查看提示" : ""}
          </span>
          <span title={snapshot?.project.root}>
            {view === "public" || view === "activity"
              ? sharedLibrary.connection?.name || "未连接公共库"
              : snapshot && view !== "projects"
                ? isDesktop ? snapshot.project.root : snapshot.project.root.startsWith("directory:") ? "本地项目文件夹" : "浏览器本地项目"
                : "映箱"}
          </span>
        </footer>
      </main>
      <input
        hidden
        type="file"
        ref={fileInput}
        multiple
        accept="image/*,video/*,audio/*,.mp3,.wav,.m4a,.ogg,.flac,.txt,.md,.pdf,.doc,.docx"
        onChange={(e) => {
          attempt(() => importFiles(Array.from(e.target.files || [])));
          e.target.value = "";
        }}
      />
      <input
        hidden
        type="file"
        ref={folderInput}
        multiple
        {...{ webkitdirectory: "", directory: "" }}
        onChange={(e) => {
          attempt(() => importFiles(Array.from(e.target.files || [])));
          e.target.value = "";
        }}
      />
      {newProject !== undefined && (
        <div className="modal-backdrop">
          <form
            className="small-modal"
            onSubmit={(e) => {
              e.preventDefault();
              attempt(async () => {
                const result = await run("createProject", {
                  name: newProject.trim(),
                });
                if (!result?.canceled) {
                  setNewProject(undefined);
                  setView("library");
                  notify("项目已创建");
                }
              });
            }}
          >
            <div className="modal-title">
              <h2>新建项目</h2>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setNewProject(undefined)}
              >
                <X size={20} />
              </button>
            </div>
            <label>
              项目名称
              <input
                autoFocus
                value={newProject}
                onChange={(e) => setNewProject(e.target.value)}
                placeholder="例如：产品宣传片"
                required
              />
            </label>
            <p>
              {isDesktop
                ? "下一步选择保存位置，可以是本地目录或共享盘。"
                : projectRootName
                  ? `项目和素材保存到已授权本地目录「${projectRootName}」。`
                  : "项目和素材保存在浏览器中，可以在设置选择本地保存目录。"}
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setNewProject(undefined)}>
                取消
              </button>
              <button
                className="primary-button"
                disabled={busy || !newProject.trim()}
              >
                {busy ? "正在创建…" : isDesktop ? "选择位置并创建" : "创建项目"}
              </button>
            </div>
          </form>
        </div>
      )}
      {urlOpen && (
        <div className="modal-backdrop">
          <form
            className="small-modal"
            onSubmit={(e) => {
              e.preventDefault();
              attempt(async () => {
                const targetId = requireReceivingProject(urlTarget?.projectId || receivingId);
                const file = await prepareRemote(url);
                await run("importFiles", {
                  projectId: targetId,
                  files: [file],
                  shotId: "",
                  category: urlTarget?.category ?? urlCategory,
                });
                await selectProject(targetId);
                setUrlOpen(false);
                notify("网页素材已保存");
              });
            }}
          >
            <div className="modal-title">
              <h2>导入网页素材</h2>
              <button type="button" onClick={() => setUrlOpen(false)}>
                <X size={20} />
              </button>
            </div>
            <label>
              图片、视频或音频直链
              <input
                autoFocus
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
                required
              />
            </label>
            <p>仅下载此地址的素材。需要登录的网站，请下载后拖入。</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setUrlOpen(false)}>
                取消
              </button>
              <button className="primary-button" disabled={busy || !url}>
                下载并导入
              </button>
            </div>
          </form>
        </div>
      )}
      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          desktop={isDesktop}
          project={snapshot?.project}
          onClose={() => setSettingsOpen(false)}
          onChooseInbox={async () => {
            await run("chooseInbox");
          }}
          onListProjectBackups={listProjectBackups}
          onCreateProjectBackup={createProjectBackup}
          onBackup={() => { setSettingsOpen(false); setExportOpen(true); }}
          onRestoreProjectBackup={restoreProjectBackup}
          directorySettings={
            !isDesktop ? (
              <LocalFolderSettings projectId={projectId} projectRoot={snapshot?.project.root} onChange={refresh} />
            ) : undefined
          }
          onSave={async (patch) => {
            await run("saveSettings", { patch });
            notify("设置已保存");
          }}
        />
      )}
      {outboundAssets.length > 0 && (
        <AssetOutboundDialog
          assets={outboundAssets}
          onClose={() => setOutboundAssets([])}
        />
      )}
      {publishAssets.length > 0 && sharedLibrary.connection && (
        <PublishToLibraryDialog
          assets={publishAssets}
          connection={sharedLibrary.connection}
          clientId={settings.deviceId || ""}
          onClose={() => setPublishAssets([])}
          onPublished={async (result) => {
            await sharedLibrary.refresh();
            setPublishAssets([]);
            notify(
              `已收录 ${result.added} 张图片${result.duplicates ? `，跳过 ${result.duplicates} 张重复图片` : ""}；项目原片保留`,
            );
          }}
        />
      )}
      {exportOpen && snapshot && (
        <ExportDialog
          snapshot={snapshot}
          canExportFolder={isDesktop}
          onClose={() => setExportOpen(false)}
          onBackup={async (includeTrash) => {
            if (document.querySelector('[data-editing-dirty="true"]'))
              throw new Error("请先等待文字或画布保存完成，并提交正在填写的批注，再创建完整备份");
            const result = await run(isDesktop ? "createProjectBackup" : "exportBackup", { projectId, includeTrash });
            try { localStorage.setItem(`weave.last-backup.${projectId}`, JSON.stringify({ createdAt: result.createdAt, assetCount: result.assetCount })); } catch {}
            notify(isDesktop ? `备份已校验并保存：${result.path || "项目备份区"}` : `备份已回读校验（${result.assetCount} 个原片，回收站 ${result.trashCount} 个），请在下载列表确认文件已保存`);
            setExportOpen(false);
          }}
          onExport={async (options) => {
            const storyboardFiles = options.include.storyboard
              ? await renderStoryboard(
                  snapshot,
                  options.layout,
                  options.labels,
                  options.fit,
                )
              : [];
            const result = await run("exportProject", {
              projectId,
              include: options.include,
              format: options.format,
              storyboardFiles,
            });
            if (!result?.canceled) {
              notify(
                isDesktop
                  ? `已导出：${result?.zipPath || result?.destination || "所选目录"}`
                  : "项目 ZIP 已生成并下载",
              );
              setExportOpen(false);
            }
          }}
        />
      )}
      {previewId && snapshot && (
        <AssetPreview
          assets={previewAssets}
          initialId={previewId}
          shots={snapshot.shots}
          paragraphs={snapshot.editing?.paragraphs || []}
          onClose={() => setPreviewId("")}
          onUpdate={async (asset, patch) => updateAssets([asset.id], patch)}
          onReveal={(asset) =>
            attempt(() => invoke("revealAsset", { projectId, id: asset.id }))
          }
          onReadDocument={(asset) =>
            invoke("readDocument", { projectId, id: asset.id })
          }
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          <span>{toast}</span>
          <button title="关闭提示" onClick={() => setToast("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {sharedLibrary.announcement && view !== "activity" && (
        <aside className="library-notice-toast" role="status">
          <Bell size={18} />
          <span>{sharedLibrary.announcement.text}</span>
          <button
            onClick={() => {
              setView("activity");
              sharedLibrary.dismissAnnouncement();
            }}
          >
            查看通知
          </button>
          <button
            aria-label="关闭新增素材提示"
            onClick={sharedLibrary.dismissAnnouncement}
          >
            <X size={15} />
          </button>
        </aside>
      )}
      {dragging &&
        view !== "shots" &&
        view !== "public" &&
        view !== "activity" &&
        !(view === "library" && filter === "all") && (
          <div className="drop-overlay">
            <UploadSimple size={40} />
            <h2>{receiver ? `松开，保存到 ${projectLabel(receiver)}` : "请先选择或新建项目"}</h2>
            <p>原文件会保留，重复素材会自动识别</p>
          </div>
        )}
    </div>
  );
}
