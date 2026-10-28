import { useEffect, useState, type ReactNode } from "react";
import { ArrowClockwise, DownloadSimple, FolderOpen, FloppyDisk } from "@phosphor-icons/react";
import type { Project, Settings } from "../types";
import { projectLabel } from "../../shared/workspace-labels.mjs";
import { FeatureDialog, errorText } from "./shared";
import "./features.css";
import { BrowserNotificationSettings } from "./BrowserNotificationSettings";
import type { BackupInfo } from "../services/projectArchive";
import { checkBrowserUpdate } from "../services/browserUpdates.mjs";
import { version as appVersion } from "../../package.json";

export type SettingsDialogProps = {
  settings: Settings;
  desktop: boolean;
  project?: Project;
  onClose: () => void;
  onSave: (patch: Partial<Settings>) => Promise<void>;
  onChooseInbox: () => Promise<void>;
  directorySettings?: ReactNode;
  onBackup?: () => void;
  onListProjectBackups?: () => Promise<BackupInfo[]>;
  onCreateProjectBackup?: () => Promise<BackupInfo>;
  onRestoreProjectBackup?: (backupId: string) => Promise<{ canceled?: boolean } | void>;
};
export function SettingsDialog({
  settings,
  desktop,
  project,
  onClose,
  onSave,
  onChooseInbox,
  directorySettings,
  onBackup,
  onListProjectBackups,
  onCreateProjectBackup,
  onRestoreProjectBackup,
}: SettingsDialogProps) {
  const [notifications, setNotifications] = useState(settings.notifications);
  const [background, setBackground] = useState(settings.background);
  const [muted, setMuted] = useState(
    !!project && !!settings.mutedProjects?.includes(project.id),
  );
  const [baseUrl, setBaseUrl] = useState(settings.api?.baseUrl ?? "");
  const [model, setModel] = useState(settings.api?.model ?? "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <FeatureDialog title="设置" onClose={onClose} busy={busy}>
      <form
        className="feature-settings feature-fields"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            await onSave({
              notifications: desktop ? notifications : true,
              ...(desktop
                ? {
                    background,
                    mutedProjects: project
                      ? [
                          ...(settings.mutedProjects || []).filter(
                            (id) => id !== project.id,
                          ),
                          ...(muted ? [project.id] : []),
                        ]
                      : settings.mutedProjects,
                  }
                : {}),
              api: {
                baseUrl: baseUrl.trim(),
                model: model.trim(),
                enabled: settings.api?.enabled ?? false,
                ...(key.trim() ? { key: key.trim() } : {}),
              },
            });
            setKey("");
            onClose();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {desktop && <fieldset className="feature-fields settings-section" disabled={busy}>
          <legend>素材接收</legend>
          <label>
            新素材默认保存到
            <input value={settings.inboxPath} readOnly />
          </label>
            <button
              type="button"
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await onChooseInbox();
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <FolderOpen />
              选择接收文件夹
            </button>
        </fieldset>}
        <details className="settings-group" open>
          <summary>项目存储与备份</summary>
          {directorySettings}
          {desktop && project && onListProjectBackups && onCreateProjectBackup && onRestoreProjectBackup && <ProjectBackupPanel
            projectId={project.id}
            onList={onListProjectBackups}
            onCreate={onCreateProjectBackup}
            onRestore={onRestoreProjectBackup}
          />}
          {!desktop && project && onBackup && <button type="button" disabled={busy} onClick={onBackup}>创建完整备份</button>}
        </details>
        {desktop && <PortableUpdatePanel />}
        {!desktop && <BrowserUpdatePanel />}
        <fieldset className="feature-fields settings-section" disabled={busy}>
          <legend>通知</legend>
          {desktop ? <>
            <label className="feature-check">
              <input type="checkbox" checked={notifications} onChange={(event) => setNotifications(event.target.checked)} />
              显示系统通知
            </label>
            {project && <label className="feature-check">
              <input type="checkbox" checked={muted} onChange={(event) => setMuted(event.target.checked)} />
              不显示「{projectLabel(project)}」的系统提醒
            </label>}
            <p className="feature-note">系统提醒只提示公共素材库新增；应用内「通知」仍保留记录。</p>
            <label className="feature-check">
              <input type="checkbox" checked={background} onChange={(event) => setBackground(event.target.checked)} />
              关闭窗口后继续运行
            </label>
          </> : <BrowserNotificationSettings enabled onChange={() => {}} disabled={busy} />}
        </fieldset>
        <details className="settings-group">
          <summary>高级 · AI 服务连接</summary>
          <fieldset className="feature-fields" disabled={busy}>
          <p className="feature-note">仅在你接入兼容的 AI 服务时需要填写；这里不会生成内容。</p>
          <label>
            服务地址
            <input
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label>
            模型名称
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            API 密钥（可选）
            <input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              autoComplete="new-password"
              spellCheck={false}
            />
          </label>
          <p className="feature-note">
            {settings.api?.hasKey
              ? "已保存密钥。留空保留现有密钥。"
              : "密钥可稍后填写。"}
            不会显示已保存的密钥。
          </p>
          </fieldset>
        </details>
        {error && (
          <p className="feature-error" role="alert">
            {error}
          </p>
        )}
        <footer className="feature-dialog-footer">
          <span className="feature-note">带勾选项和 AI 配置需点击保存；目录操作即时生效。</span>
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="feature-primary" type="submit" disabled={busy}>
            <FloppyDisk />
            {busy ? "正在保存…" : "保存设置"}
          </button>
        </footer>
      </form>
    </FeatureDialog>
  );
}

function BrowserUpdatePanel() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [download, setDownload] = useState<{ version: string; url: string }>();
  const check = async () => {
    setBusy(true); setMessage(""); setDownload(undefined);
    try {
      const update = await checkBrowserUpdate(appVersion);
      if (update.available) {
        setDownload(update);
        setMessage(`发现新版 ${update.version}。请下载浏览器版更新包。`);
      } else setMessage(`GitHub 最新正式版本：${update.version}。`);
    } catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  };
  return <fieldset className="feature-fields settings-section">
    <legend>软件更新</legend>
    <p className="feature-note">浏览器版 {appVersion} · 更新前建议先备份项目。请保留原来的 Weave.html 路径，以便继续访问浏览器中的项目。</p>
    <div className="feature-actions">
      <button type="button" disabled={busy} onClick={() => void check()}><ArrowClockwise />{busy ? "正在检查…" : "检查更新"}</button>
      {download && <a href={download.url} target="_blank" rel="noopener noreferrer">下载 {download.version}</a>}
    </div>
    {message && <p className="feature-note" role="status">{message}</p>}
    {download && <p className="feature-note">下载后请解压，关闭其他映箱页面，再将新包里的 Weave.html 覆盖到原位置。项目文件夹不要覆盖；页面无法自动校验下载结果。</p>}
  </fieldset>;
}

type PortableUpdateState = {
  state: "checking" | "current" | "available" | "downloading" | "downloaded" | "error";
  currentVersion?: string;
  version?: string;
  size?: number;
  path?: string;
  message?: string;
};

function PortableUpdatePanel() {
  const [status, setStatus] = useState<PortableUpdateState>({ state: "checking" });
  const [busy, setBusy] = useState(false);
  const inspect = async (download: boolean) => {
    const bridge = window.weaveDesktop;
    if (!bridge) return;
    setBusy(true);
    setStatus({ state: "checking" });
    try {
      const latest = await bridge.checkForUpdates();
      if (latest.unsupported) {
        setStatus({ state: "error", message: "自动更新仅适用于 Windows 便携桌面版。" });
      } else if (!latest.available) {
        setStatus({ state: "current", currentVersion: latest.currentVersion });
      } else if (download) {
        setStatus({ state: "downloading", version: latest.version, size: latest.size });
        const result = await bridge.downloadUpdate();
        setStatus(result.state === "downloaded" ? result : { state: "current", currentVersion: result.currentVersion });
      } else {
        setStatus({ state: "available", version: latest.version, size: latest.size });
      }
    } catch (error) {
      setStatus({ state: "error", message: errorText(error) });
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const unsubscribe = window.weaveDesktop?.onUpdate((next) => {
      if (["checking", "current", "downloading", "downloaded", "error"].includes(next?.state))
        setStatus(next);
    });
    void inspect(true);
    return unsubscribe;
  }, []);
  return <fieldset className="feature-fields settings-section" disabled={busy}>
    <legend>软件更新</legend>
    <p className="feature-note">
      Windows 便携版启动时会检查并自动下载新版，下载后校验文件完整性。更新包只替换 映箱程序目录，不会改动项目目录；安装位置需允许当前用户写入。
    </p>
    <p className="feature-note" role="status">
      {status.state === "checking" ? "正在检查更新…" :
        status.state === "current" ? `当前已是最新版本${status.currentVersion ? `（${status.currentVersion}）` : ""}。` :
          status.state === "available" ? `发现新版本 ${status.version}（${formatUpdateSize(status.size)}）。` :
            status.state === "downloading" ? `正在下载映箱 ${status.version}（${formatUpdateSize(status.size)}）…` :
              status.state === "downloaded" ? `映箱 ${status.version} 已下载并校验完成。请关闭软件后，将 ZIP 解压并覆盖旧的映箱程序文件；不要覆盖项目文件夹。` :
                status.message || "尚未检查更新。"}
    </p>
    <div className="project-backup-heading">
      <button type="button" disabled={busy} onClick={() => void inspect(true)}>
        {status.state === "available" ? <DownloadSimple /> : <ArrowClockwise />}
        {busy ? "处理中…" : status.state === "available" ? "下载更新" : "检查更新"}
      </button>
      {status.state === "downloaded" && status.path && <button type="button" onClick={() => void window.weaveDesktop?.openUpdate(status.path!)}>
        <FolderOpen /> 打开下载位置
      </button>}
    </div>
  </fieldset>;
}

function formatUpdateSize(value?: number) {
  if (!Number.isFinite(value) || !value) return "大小未知";
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;
}

function ProjectBackupPanel({
  projectId,
  onList,
  onCreate,
  onRestore,
}: {
  projectId: string;
  onList: () => Promise<BackupInfo[]>;
  onCreate: () => Promise<BackupInfo>;
  onRestore: (backupId: string) => Promise<{ canceled?: boolean } | void>;
}) {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const reload = async () => {
    const items = await onList();
    setBackups(items);
    setLoaded(true);
  };
  useEffect(() => {
    let current = true;
    void onList().then(items => { if (current) { setBackups(items); setLoaded(true); } }).catch(reason => { if (current) { setError(errorText(reason)); setLoaded(true); } });
    return () => { current = false; };
  }, [projectId, onList]);
  const create = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      const backup = await onCreate();
      await reload();
      setMessage(`已完成校验备份 · ${new Date(backup.createdAt).toLocaleString()}`);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  const restore = async (backup: BackupInfo) => {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await onRestore(backup.id);
      if (result?.canceled) return;
      setMessage("恢复为独立项目已完成，原项目与备份均保留。");
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  return <section className="project-backup-panel" aria-label="项目备份">
    <div className="project-backup-heading"><strong>项目备份</strong><button type="button" disabled={busy} onClick={() => void create()}>{busy ? "处理中…" : "立即创建备份"}</button></div>
    {!loaded ? <p className="feature-note">正在读取备份记录…</p> : backups.length ? <ul>{backups.slice(0, 4).map(backup => <li key={backup.id}>
      <span><b>{new Date(backup.createdAt).toLocaleString()}</b><small>{backup.reason} · {backup.assetCount} 个素材 · {formatBytes(backup.size)}</small></span>
      <button type="button" disabled={busy} title="校验备份后恢复到你选择的空文件夹，不覆盖当前项目" onClick={() => void restore(backup)}>恢复为副本</button>
    </li>)}</ul> : <p className="feature-note">暂无项目备份；新建的完整备份会保存在项目目录旁的 映箱备份区。</p>}
    {message && <p className="feature-success" role="status">{message}</p>}
    {error && <p className="feature-error" role="alert">{error}</p>}
  </section>;
}

function formatBytes(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
