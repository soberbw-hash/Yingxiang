import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createLibraryNoticeStore,
  deliverLibraryNotices,
  noticeGroups,
  type NoticeState,
} from "../services/libraryNotices";
import type { LibrarySnapshot } from "../services/sharedLibrary";
import { sendBrowserNotification } from "../services/browserNotifications";
import { libraryUpdateSummary } from "../services/libraryUpdates";

export function useLibraryNotices(
  snapshot: LibrarySnapshot | undefined,
  clientId: string,
  enabled: boolean,
  onOpen: (libraryId: string) => void,
) {
  const libraryId = snapshot?.id;
  const store = useMemo(
    () =>
      libraryId && clientId
        ? createLibraryNoticeStore(libraryId, clientId, {
            getItem: (key) => localStorage.getItem(key),
            setItem: (key, value) => localStorage.setItem(key, value),
          })
        : undefined,
    [libraryId, clientId],
  );
  const [state, setState] = useState<NoticeState>();
  const [error, setError] = useState("");
  const [delivery, setDelivery] = useState("");
  const [announcement, setAnnouncement] = useState<{
    libraryId: string;
    text: string;
  }>();
  const latest = useRef({ enabled, onOpen });
  latest.current = { enabled, onOpen };
  const current = useRef(store);
  current.current = store;
  const pump = useCallback(async () => {
    if (!store) return;
    try {
      const result = await deliverLibraryNotices(
        store,
        (pending) => {
          if (current.current !== store) return "disabled";
          return sendBrowserNotification({
            enabled: latest.current.enabled,
            title: "映箱 · 通知",
            body: libraryUpdateSummary(pending),
            tag: `weave-library:${libraryId}`,
            onClick: () => latest.current.onOpen(libraryId!),
          });
        },
        typeof navigator !== "undefined" && navigator.locks
          ? (key, work) => navigator.locks.request(key, work)
          : undefined,
      );
      if (current.current !== store) return;
      if (result === "submitted") setState(store.read());
      setDelivery(
        result === "failed"
          ? "系统提醒提交失败；未读通知已保留，可在系统提醒中重试测试。"
          : result === "unavailable" && latest.current.enabled
            ? "系统提醒不可用；软件内通知仍正常接收。"
            : "",
      );
    } catch {
      if (current.current === store)
        setError("通知状态未能保存，未重置记录；请检查浏览器存储权限。");
    }
  }, [store, libraryId]);
  useEffect(() => {
    setState(undefined);
    setError("");
    setDelivery("");
    setAnnouncement(undefined);
  }, [store]);
  useEffect(() => {
    if (!store || !snapshot) return;
    try {
      const result = store.observe(snapshot.updates);
      setState(result.state);
      setError("");
      if (result.added.length)
        setAnnouncement({
          libraryId: snapshot.id,
          text: libraryUpdateSummary(result.added),
        });
      void pump();
    } catch (reason) {
      setError(
        (reason as Error).message || "通知未能保存，请检查浏览器存储权限。",
      );
    }
  }, [store, snapshot, pump]);
  useEffect(() => {
    void pump();
  }, [enabled, pump]);
  useEffect(() => {
    const focus = () => void pump();
    const sync = (event: StorageEvent) => {
      if (!store || (event.key !== store.key && event.key !== null)) return;
      try {
        setState(store.read());
        setError("");
        void pump();
      } catch (reason) {
        setError((reason as Error).message);
      }
    };
    window.addEventListener("storage", sync);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [store, pump]);
  useEffect(() => {
    if (!announcement) return;
    const timer = window.setTimeout(() => setAnnouncement(undefined), 10000);
    return () => clearTimeout(timer);
  }, [announcement]);
  const notices =
    state?.libraryId === libraryId && state?.clientId === clientId
      ? state.entries
      : [];
  return {
    notices,
    unread: noticeGroups(notices).filter((group) => group.unread).length,
    error,
    delivery,
    announcement,
    dismissAnnouncement: () => setAnnouncement(undefined),
    markRead: (ids?: string[], readValue = true) => {
      if (!store) return;
      try {
        setState(store.markRead(ids, readValue));
        setError("");
      } catch (reason) {
        setError((reason as Error).message || "已读状态未能保存，请稍后重试。");
      }
    },
  };
}
