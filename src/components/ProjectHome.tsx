import { useRef, useState } from "react";
import { Archive, FolderOpen, FolderSimple, Plus, MagnifyingGlass, X } from "@phosphor-icons/react";
import type { Project } from "../types";
import { projectLabel } from "../../shared/workspace-labels.mjs";
import { formatDate, formatSize } from "../types";
import { parseProjectArchive, type PreparedProjectArchive } from "../services/projectArchive";
import { FeatureDialog } from "../features/shared";
import { readPreference } from "../services/workspacePreferences";
import { matchesSearch } from "../services/workspaceSearch";
export function ProjectHome({
  projects,
  onOpen,
  onCreate,
  onSelect,
  desktop,
  folderName,
  onRestoreArchive,
  currentProjectId,
  inboxPath,
  onChooseInbox,
}: {
  projects: Project[];
  onOpen: () => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
  desktop: boolean;
  folderName?: string;
  onRestoreArchive?: (prepared: PreparedProjectArchive) => Promise<void>;
  currentProjectId?: string;
  inboxPath?: string;
  onChooseInbox?: () => Promise<void>;
}) {
  const archiveInput = useRef<HTMLInputElement>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState("");
  const [prepared, setPrepared] = useState<PreparedProjectArchive>();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const shown = projects.filter(project => matchesSearch(query, projectLabel(project)))
    .sort((a, b) => sort === "name" ? projectLabel(a).localeCompare(projectLabel(b), "zh-CN")
      : (sort === "created" ? b.createdAt : b.updatedAt || b.createdAt).localeCompare(sort === "created" ? a.createdAt : a.updatedAt || a.createdAt));
  return (
    <section className="project-home">
      <div className="view-heading">
        <div>
          <span className="eyebrow">创作工作区</span>
          <h1>项目</h1>
          <p>每个项目，都有自己的素材和制作进度。</p>
        </div>
        <div className="heading-actions">
          {!desktop && onRestoreArchive && <>
            <button type="button" disabled={restoreBusy} onClick={() => archiveInput.current?.click()} title="校验 ZIP 备份并恢复为独立项目，原项目不会覆盖">
              <Archive size={17} />{restoreBusy ? prepared ? "正在恢复…" : "正在校验…" : "恢复备份"}
            </button>
            <input ref={archiveInput} type="file" accept=".zip,application/zip" hidden onChange={async event => {
              const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
              if (!file) return;
              setRestoreBusy(true); setRestoreError("");
              try { setPrepared(await parseProjectArchive(file)); }
              catch (reason) { setRestoreError((reason as Error).message || "备份恢复失败"); }
              finally { setRestoreBusy(false); }
            }} />
          </>}
          <button
            onClick={onOpen}
            title={
              desktop
                ? "打开本地或共享盘里的项目文件夹"
                : "授权读取 映箱本地项目文件夹"
            }
          >
            <FolderOpen size={17} />
            打开项目文件夹
          </button>
          <button className="primary-button" onClick={onCreate}>
            <Plus size={17} />
            新建项目
          </button>
        </div>
      </div>
      {!!projects.length && <div className="project-browser-tools">
        <label className="project-search"><MagnifyingGlass size={16} aria-hidden="true" />
          <input aria-label="搜索项目" placeholder="搜索项目名称" value={query} onChange={event => setQuery(event.target.value)} />
          {query && <button type="button" aria-label="清除项目搜索" onClick={() => setQuery("")}><X size={15} /></button>}
        </label>
        {query && <span role="status">找到 {shown.length} 个项目</span>}
        <select aria-label="项目排序" value={sort} onChange={event => setSort(event.target.value)}><option value="recent">最近更新</option><option value="name">名称排序</option><option value="created">最近创建</option></select>
      </div>}
      {query && !shown.length && <div className="empty-state project-search-empty"><MagnifyingGlass size={28} /><h2>没有找到这个项目</h2><p>试试项目名称中的其他词语。</p><button onClick={() => setQuery("")}>清除搜索</button></div>}
      <div className="project-grid">
        {shown.map((p) => {
          const inbox = !!p.publicInbox;
          return (
          <div
            className={`project-card${p.id === currentProjectId ? " is-current-project" : ""}${inbox ? " is-inbox" : ""}`}
            key={p.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(p.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(p.id);
              }
            }}
          >
            <div className="project-folder">
              <FolderSimple size={36} weight="duotone" />
            </div>
            <h3>{projectLabel(p)}</h3>
            {p.id === currentProjectId && <small className="project-current-badge">当前项目</small>}
            {inbox ? (
              <div className="inbox-summary">
                <p className="inbox-hint" title={inboxPath || undefined}>
                  {inboxPath
                    ? "自动接收这个文件夹里的新素材，再分给具体项目。"
                    : "你下载的素材会先进这里，再分给具体项目。"}
                </p>
                <p className="inbox-path">{inboxPath || "还没有选择接收文件夹"}</p>
                <div className="inbox-actions">
                  {onChooseInbox && (
                    <button
                      type="button"
                      className="inbox-choose"
                      onClick={(event) => {
                        event.stopPropagation();
                        void onChooseInbox();
                      }}
                    >
                      <FolderOpen size={15} />
                      {inboxPath ? "更换接收文件夹" : "选择接收文件夹"}
                    </button>
                  )}
                  <span className="inbox-count">{p.assetCount ?? 0} 个素材</span>
                </div>
              </div>
            ) : (
              <>
                <p>{projectLocation(p.root)}</p>
                {p.unavailable ? <span>项目暂不可用 · 检查文件夹连接</span> : <>
                  <span>{p.assetCount ?? 0} 个素材 · {p.paragraphCount ?? 0} 个文稿段落</span>
                  <span>最近更新 {formatDate(p.updatedAt || p.createdAt)}</span>
                  <span>{lastBackupLabel(p.id)}</span>
                </>}
              </>
            )}
          </div>
          );
        })}
        {!query && <button className="project-card create-card" onClick={onCreate}>
          <Plus size={28} />
          <h3>新建项目</h3>
          <p>
            {desktop
              ? "选择本地目录或共享盘"
              : folderName
                ? `保存到本地目录 · ${folderName}`
                : "保存在这台设备的浏览器"}
          </p>
        </button>}
      </div>
      {restoreError && <p className="feature-error" role="alert">{restoreError}</p>}
      {prepared && <FeatureDialog title="确认恢复项目" onClose={() => setPrepared(undefined)} busy={restoreBusy}>
        <div className="recovery-preview">
          <p className="feature-success" role="status">ZIP 结构与全部原片的 SHA-256 校验已通过</p>
          <h3>{prepared.record.project.name}</h3>
          <dl className="recovery-counts">
            <div><dt>在用素材</dt><dd>{prepared.record.assets.filter(a => !a.trashedAt).length}</dd></div>
            <div><dt>回收站素材</dt><dd>{prepared.record.assets.filter(a => a.trashedAt).length}</dd></div>
            <div><dt>文稿段落</dt><dd>{prepared.record.editing?.paragraphs.length || 0}</dd></div>
            <div><dt>历史版本</dt><dd>{prepared.record.editingHistory?.length || 0}</dd></div>
          </dl>
          <p>原片共 {formatSize(prepared.media.reduce((sum, item) => sum + item.blob.size, 0))} · 画布 {prepared.record.canvas?.nodes.length || 0} 项</p>
          {prepared.archiveKind === "delivery" && <p className="feature-note">这是交付导出包，只能恢复当时勾选导出的内容；未导出的原片、历史和回收站不在包内。需要保留回收站时，请选择完整备份。</p>}
          <p className="feature-note">恢复为新的独立项目，名称后加“恢复”；现有项目保留。</p>
          <div className="feature-actions"><button disabled={restoreBusy} onClick={() => setPrepared(undefined)}>取消</button><button className="feature-primary" disabled={restoreBusy} onClick={async () => {
            setRestoreBusy(true); setRestoreError("");
            try { await onRestoreArchive!(prepared); setPrepared(undefined); }
            catch (reason) { setRestoreError((reason as Error).message); }
            finally { setRestoreBusy(false); }
          }}>{restoreBusy ? "正在恢复…" : "恢复为独立项目"}</button></div>
          {restoreError && <p className="feature-error" role="alert">{restoreError}</p>}
        </div>
      </FeatureDialog>}
      {!projects.length && (
        <div className="home-help">
          <strong>从一个项目开始</strong>
          <span>
            创建后拖入素材，或在桌面端设置「自动接收文件夹」，下载的新素材会先进「待整理」。项目内容可以完整打包带走。
          </span>
        </div>
      )}
    </section>
  );
}

function lastBackupLabel(projectId: string) {
  const last = readPreference<{ createdAt?: string } | null>(`weave.last-backup.${projectId}`, null);
  return last?.createdAt && Number.isFinite(Date.parse(last.createdAt)) ? `上次生成备份 ${formatDate(last.createdAt)}` : "暂无本机备份记录";
}

function projectLocation(root?: string) {
  if (!root || root.startsWith("indexeddb://")) return "浏览器本地保存";
  if (root.startsWith("directory:")) return "已连接的本地文件夹";
  if (root.startsWith("本地文件夹 · ")) return root;
  const folder = root.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return folder ? `本地文件夹 · ${folder}` : "本地文件夹";
}
