import { useCallback, useEffect, useRef, useState } from "react";
import {
  folderConnections,
  rememberFolder,
  forgetFolder,
  ensureIndependentFolder,
  type FolderConnection,
} from "../services/folderConnections";
import {
  directoryPermission,
  pickDirectory,
  readDiskFile,
} from "../services/directoryFiles";
import {
  initializeLibrary,
  scanExternalLibrary,
  syncLibraryDirectory,
  sharedAssetBlob,
  type LibrarySnapshot,
} from "../services/sharedLibrary";
import type { ScanState } from "../services/directoryScan";
import { useLibraryNotices } from "./useLibraryNotices";

export function useSharedLibrary(
  clientId: string,
  notifications: boolean,
  onOpenNotifications: () => void,
) {
  const [connection, setConnection] = useState<FolderConnection>();
  const [snapshot, setSnapshot] = useState<LibrarySnapshot>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkedAt, setCheckedAt] = useState("");
  const scans = useRef<ScanState>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const urls = useRef(new Map<string, { key: string; url: string }>());
  const current = useRef(connection);
  current.current = connection;
  const running = useRef(false);
  const alive = useRef(true);
  const notices = useLibraryNotices(
    snapshot,
    clientId,
    notifications,
    (libraryId) => {
      if (current.current?.id === libraryId) onOpenNotifications();
    },
  );
  useEffect(() => {
    let live = true;
    void folderConnections()
      .then((items) => {
        if (live) setConnection(items.find((item) => item.kind === "library"));
      })
      .catch((reason) => {
        if (live) setError((reason as Error).message);
      });
    return () => {
      live = false;
    };
  }, []);
  const refresh = useCallback(async (): Promise<void> => {
    const target = current.current;
    if (!target || running.current) return;
    running.current = true;
    setRefreshing(true);
    try {
      const next =
        target.mode === "readonly"
          ? await scanExternalLibrary(target.handle, target.id)
          : (
              await syncLibraryDirectory(
                target.handle,
                scans.current,
                undefined,
                clientId,
              )
            ).snapshot;
      const keep = new Set<string>();
      for (const asset of next.assets) {
        if (asset.trashedAt) continue;
        keep.add(asset.id);
        const key = `${target.id}:${asset.head}:${asset.relativePath}:${asset.size}:${asset.createdAt}`;
        let cached = urls.current.get(asset.id);
        if (cached?.key !== key) {
          if (cached) URL.revokeObjectURL(cached.url);
          try {
            const blob =
              target.mode === "readonly"
                ? await readDiskFile(target.handle, asset.relativePath)
                : await sharedAssetBlob(target.handle, asset);
            cached = {
              key,
              url: URL.createObjectURL(blob.slice(0, blob.size, asset.mime)),
            };
            urls.current.set(asset.id, cached);
          } catch {
            next.warnings.push(`原片暂不可访问：${asset.name}`);
            cached = undefined;
          }
        }
        asset.url = cached?.url;
      }
      for (const [id, cached] of urls.current)
        if (!keep.has(id)) {
          URL.revokeObjectURL(cached.url);
          urls.current.delete(id);
        }
      if (current.current !== target || !alive.current) return;
      setSnapshot(next);
      setCheckedAt(new Date().toISOString());
      setError("");
    } catch (reason) {
      if (alive.current && current.current === target)
        setError((reason as Error).message);
    } finally {
      running.current = false;
      if (alive.current) setRefreshing(false);
      if (alive.current && current.current !== target) void refresh();
    }
  }, []);
  useEffect(() => {
    setSnapshot(undefined);
    setError("");
    setCheckedAt("");
    scans.current = new Map();
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 20000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [connection, refresh]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const cached of urls.current.values())
        URL.revokeObjectURL(cached.url);
      urls.current.clear();
    };
  }, []);
  const connect = async (mode: "managed" | "readonly" | "create") => {
    // Picker before setBusy/await keeps the click activation intact.
    const choice = pickDirectory(mode === "readonly");
    setBusy(true);
    setError("");
    try {
      let handle = await choice;
      await directoryPermission(handle, mode !== "readonly", true);
      await ensureIndependentFolder(handle, "library");
      const prior = current.current;
      if (prior && !(prior.handle.isSameEntry && await prior.handle.isSameEntry(handle)) && !window.confirm(
        `切换公共库至「${handle.name}」？原公共库和个人项目均保留，不会自动合并。`,
      )) return;
      if (mode === "create")
        handle = await handle.getDirectoryHandle(
          `映箱公共资产库__${crypto.randomUUID().slice(0, 8)}`,
          { create: true },
        );
      const sameReadOnly =
        mode === "readonly" &&
        prior?.mode === "readonly" &&
        prior.handle.isSameEntry &&
        (await prior.handle.isSameEntry(handle));
      const id =
        mode === "readonly"
          ? sameReadOnly
            ? prior!.id
            : crypto.randomUUID()
          : mode === "create"
            ? await initializeLibrary(handle)
            : await initializeLibrary(handle);
      const next: FolderConnection = {
        key: "public-library",
        kind: "library",
        handle,
        name: handle.name,
        id,
        mode: mode === "readonly" ? "readonly" : "managed",
      };
      await rememberFolder(next);
      setConnection(next);
    } catch (reason) {
      if ((reason as Error).name !== "AbortError")
        setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const authorize = async () => {
    if (!connection) return;
    const permission = directoryPermission(
      connection.handle,
      connection.mode !== "readonly",
      true,
    );
    setBusy(true);
    try {
      await permission;
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return {
    ...notices,
    connection,
    snapshot,
    checkedAt,
    error: error || notices.error,
    busy,
    refreshing,
    refresh,
    connect,
    authorize,
    disconnect: async () => {
      await forgetFolder("public-library");
      setConnection(undefined);
      setSnapshot(undefined);
    },
  };
}
