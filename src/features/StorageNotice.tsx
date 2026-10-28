import type { Project } from "../types";
import { readPreference } from "../services/workspacePreferences";

export function StorageNotice({ project, status, onBackup }: { project?: Project; status: string; onBackup: () => void }) {
  const backup = readPreference<any>(`weave.last-backup.${project?.id}`, null);
  const date = typeof backup?.createdAt === "string" && Number.isFinite(Date.parse(backup.createdAt)) ? new Date(backup.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  const directory = project?.root.startsWith("directory:");
  return <details className="storage-notice">
    <summary aria-label="查看存储和备份状态"><span className="storage-state-dot" />存储</summary>
    <div><p><strong>{directory ? `本地目录 · ${status || "已连接"}` : "保存在此浏览器"}</strong>{project && <> · {date ? `上次生成备份 ${date}` : "暂无本机备份记录"}</>}</p><p>{directory ? "项目更改会写入已授权的文件夹；请留意保存失败或目录断连提示。" : "浏览器数据按打开地址分别保存；换浏览器、地址或清理站点数据后，需要从完整备份恢复。"}</p><p>公共素材库需要单独连接；接收目录更新时请保持页面打开。</p>{project && <button onClick={onBackup}>创建完整备份</button>}</div>
  </details>;
}
