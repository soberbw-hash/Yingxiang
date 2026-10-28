import { useMemo } from "react";
import type { Asset, EditDocument } from "../../types";
import { formatSize } from "../../types";
import { planEditingVideos } from "../../services/editingHandoff";

export function VideoDeliveryList({ document, assets }: { document: EditDocument; assets: Asset[] }) {
  const result = useMemo(() => {
    try { return { plan: planEditingVideos(document, assets), error: "" }; }
    catch (reason) { return { plan: undefined, error: (reason as Error).message }; }
  }, [document, assets]);
  return <section className="video-delivery-list" aria-label="视频交付清单">
    <h3>按文稿顺序导出视频</h3>
    {result.error ? <p className="feature-error" role="alert">{result.error}</p> : result.plan && <>
      <p>{result.plan.files.length} 个视频 · {formatSize(result.plan.totalBytes)} · 每组仅导出置顶版本</p>
      {!!result.plan.withoutVideo.length && <p className="feature-note">第 {result.plan.withoutVideo.slice(0, 10).join("、")}{result.plan.withoutVideo.length > 10 ? ` 等 ${result.plan.withoutVideo.length}` : ""} 段未关联视频，将跳过这些段落，保留原段号。</p>}
      {result.plan.totalBytes > 300 * 1024 * 1024 && <p className="feature-error" role="alert">视频总量超过本次浏览器打包的 300 MB 上限，请减少关联视频后重试。</p>}
      <div className="delivery-table-wrap"><table><thead><tr><th>段落</th><th>导出文件名</th><th>大小</th></tr></thead><tbody>{result.plan.files.map(file => <tr key={`${file.paragraph}:${file.asset.id}`}><td>{file.paragraph}{file.options > 1 ? ` · 选项 ${file.option}` : ""}</td><td>{file.filename}</td><td>{formatSize(file.asset.size)}</td></tr>)}</tbody></table></div>
      {!result.plan.files.length && <p className="feature-empty">先为段落关联视频，再导出。</p>}
    </>}
  </section>;
}
