import { useEffect, useState } from "react";
import {
  folderConnections,
  rememberFolder,
  forgetFolder,
  ensureIndependentFolder,
  type FolderConnection,
} from "../services/folderConnections";
import {
  pickDirectory,
  directoryPermission,
  directoryAccessMessage,
} from "../services/directoryFiles";
import {
  attachProjectFolder,
  folderBrowserInvoke,
} from "../services/folderBrowser";

export function LocalFolderSettings({
  projectId,
  projectRoot,
  onChange,
}: {
  projectId?: string;
  projectRoot?: string;
  onChange: () => Promise<unknown>;
}) {
  const [folders, setFolders] = useState<FolderConnection[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const reload = () => folderConnections().then(setFolders);
  useEffect(() => {
    void reload().catch((reason) => setError((reason as Error).message));
  }, []);
  const root = folders.find((item) => item.kind === "project-root");
  const current = folders.find(
    (item) => item.kind === "project" && item.id === projectId,
  );
  const choose = async (mode: "root" | "save" | "open" | "relocate") => {
    const choice = pickDirectory();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const handle = await choice;
      if (mode === "root") {
        await directoryPermission(handle, true, true);
        await ensureIndependentFolder(handle, "local");
        await rememberFolder({
          key: "local-project-root",
          kind: "project-root",
          handle,
          name: handle.name,
          id: crypto.randomUUID(),
        });
        setMessage("新项目将保存到此目录；原有浏览器项目不搬迁。");
      } else if (mode === "relocate") {
        await directoryPermission(handle, true, true);
        const result = await folderBrowserInvoke("relocateProjectFolder", {
          projectId,
          handle,
        });
        setMessage(
          `已校验并切换至「${result.name}」，项目身份不变，原位置保留。后续只使用新位置编辑。`,
        );
      } else {
        await attachProjectFolder(
          handle,
          mode === "save" ? projectId : undefined,
        );
        setMessage(
          mode === "save"
            ? "已验证原片并另存独立目录副本，原项目保留。"
            : "已从目录读取项目。",
        );
      }
      await reload();
      await onChange();
    } catch (reason) {
      if ((reason as Error).name !== "AbortError")
        setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="feature-fields" disabled={busy}>
      <legend>当前项目</legend>
      {(!window.isSecureContext || !("showDirectoryPicker" in window)) && <p className="feature-note">{directoryAccessMessage()}</p>}
      <p className="feature-note">
        {!projectId ? "请先选择项目。" : current ? `保存在文件夹：${current.name}` : projectRoot?.startsWith("directory:") ? "项目文件夹暂未连接，请重新打开项目文件夹。" : "保存在此浏览器"}
      </p>
      <div className="feature-actions">
        <button
          type="button"
          disabled={!projectId}
          title="复制并校验当前项目后切换位置，原位置保留"
          onClick={() => void choose("relocate")}
        >
          更改保存位置
        </button>
      </div>
      <details className="folder-advanced">
        <summary>更多目录操作</summary>
        <p className="feature-note">{root ? `新项目默认目录：${root.name}` : "新项目默认保存在浏览器。"}</p>
        <div className="feature-actions">
        <button type="button" onClick={() => void choose("root")} title="只影响之后新建的项目，不移动已有项目">
          {root ? "更改新项目默认目录" : "设置新项目默认目录"}
        </button>
        <button type="button" onClick={() => void choose("open")}>
          打开文件夹项目
        </button>
        <button
          type="button"
          disabled={!projectId}
          onClick={() => void choose("save")}
        >
          另存当前项目副本
        </button>
        {(root || current) && (
          <button
            type="button"
            onClick={() => {
              const permission = directoryPermission(
                (current || root)!.handle,
                true,
                true,
              );
              setBusy(true);
              void permission
                .then(() => setMessage("目录已授权"))
                .catch((reason) => setError((reason as Error).message))
                .finally(() => setBusy(false));
            }}
          >
            重新授权
          </button>
        )}
        {current && (
          <button
            type="button"
            onClick={() => {
              setBusy(true);
              setError("");
              void folderBrowserInvoke("syncProjectFolder", { projectId })
                .then(async (result) => {
                  await onChange();
                  setMessage(
                    result.warnings?.join("；") ||
                      (result.pending
                        ? "文件仍在写入，下一次检查后自动收录。"
                        : `目录已检查，新增 ${result.imported || 0} 个素材。`),
                  );
                })
                .catch((reason) => setError((reason as Error).message))
                .finally(() => setBusy(false));
            }}
          >
            立即检查目录
          </button>
        )}
        {root && (
          <button
            type="button"
            onClick={() => {
              setBusy(true);
              void forgetFolder(root.key)
                .then(reload)
                .then(onChange)
                .catch((reason) => setError((reason as Error).message))
                .finally(() => setBusy(false));
            }}
          >
            恢复浏览器保存（不删除文件）
          </button>
        )}
        </div>
        <p className="feature-note">目录操作需要浏览器授权。更改位置或另存时，原项目会保留。请勿手动修改 _Weave 和受管理原片。</p>
      </details>
      {error && (
        <p role="alert" className="feature-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="feature-note">
          {message}
        </p>
      )}
    </fieldset>
  );
}
