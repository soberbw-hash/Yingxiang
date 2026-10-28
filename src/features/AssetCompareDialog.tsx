import { useEffect, useRef, useState } from "react";
import type { Asset } from "../types";
import { formatSize } from "../types";
import type { StackAction } from "../../shared/asset-stacks.mjs";
import { FeatureDialog } from "./shared";

function SynchronizedVideos({ first, second }: { first: Asset; second: Asset }) {
  const left = useRef<HTMLVideoElement>(null), right = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false), [time, setTime] = useState(0);
  const [durations, setDurations] = useState([0, 0]), [error, setError] = useState("");
  const playAttempt = useRef(0);
  const duration = durations.every(x => Number.isFinite(x) && x > 0) ? Math.min(...durations) : 0;
  const pause = () => { playAttempt.current++; left.current?.pause(); right.current?.pause(); setPlaying(false); };
  useEffect(() => () => { playAttempt.current++; }, []);
  const play = async () => {
    if (!left.current || !right.current || !duration) return;
    const token = ++playAttempt.current;
    const a = left.current, b = right.current;
    setError("");
    if (a.currentTime >= duration - 0.05) a.currentTime = 0;
    b.currentTime = a.currentTime;
    try {
      await Promise.all([a.play(), b.play()]);
      if (playAttempt.current === token) setPlaying(true);
      else { a.pause(); b.pause(); }
    } catch { a.pause(); b.pause(); setPlaying(false); setError("同步播放未完成，请检查视频能否解码后重试"); }
  };
  return <div className="synchronized-compare">
    <div className="comparison-panes">{[first, second].map((asset, i) => <figure key={asset.id}>
      <video ref={i === 0 ? left : right} src={asset.url} muted playsInline preload="metadata" onLoadedMetadata={event => {
        const d = event.currentTarget.duration;
        setDurations(old => old.map((value, index) => index === i ? d : value));
      }} onError={() => { pause(); setError(`无法解码：${asset.name}`); }} onEnded={pause}
        onTimeUpdate={i === 0 ? () => {
          const a = left.current, b = right.current;
          if (!a || !b) return;
          setTime(a.currentTime);
          if (playing && Math.abs(a.currentTime - b.currentTime) > 0.15) b.currentTime = Math.min(a.currentTime, duration);
          if (duration && a.currentTime >= duration) pause();
        } : undefined} />
      <figcaption>{asset.name}</figcaption>
    </figure>)}</div>
    <div className="comparison-playback"><button disabled={!duration || !!error} onClick={() => playing ? pause() : void play()}>{playing ? "暂停" : "同步播放"}</button>
      <input type="range" aria-label="同步视频进度" min={0} max={duration || 1} step={0.01} value={Math.min(time, duration)} disabled={!duration} onChange={event => {
        const value = Number(event.target.value);
        if (left.current) left.current.currentTime = value;
        if (right.current) right.current.currentTime = value;
        setTime(value);
      }} /><span>{time.toFixed(1)} / {duration.toFixed(1)} 秒</span></div>
    <p className="feature-note">同步播放默认静音，以较短视频的结束位置为准；使用共同进度条逐段比较。</p>
    {error && <p className="feature-error" role="alert">{error} <button onClick={() => { pause(); setError(""); setDurations([0, 0]); left.current?.load(); right.current?.load(); }}>重新读取视频</button></p>}
  </div>;
}

export function AssetCompareDialog({ assets, initialIds, onClose, onStackAction }: {
  assets: Asset[]; initialIds: string[]; onClose: () => void; onStackAction: (action: StackAction) => Promise<unknown>;
}) {
  const candidates = assets.filter(a => !a.trashedAt && ["image", "video"].includes(a.kind));
  const [leftId, setLeftId] = useState(initialIds[0] || candidates[0]?.id || "");
  const [rightId, setRightId] = useState(initialIds[1] || candidates.find(a => a.id !== leftId)?.id || "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const first = candidates.find(a => a.id === leftId), second = candidates.find(a => a.id === rightId);
  const sameStack = first?.kind === "video" && first.stackId && first.stackId === second?.stackId;
  return <FeatureDialog title="素材并排对比" wide busy={busy} onClose={onClose}>
    <div className="asset-compare">
      <div className="comparison-selectors">{[leftId, rightId].map((id, i) => <label key={i}>{i === 0 ? "左侧素材" : "右侧素材"}<select aria-label={i === 0 ? "左侧对比素材" : "右侧对比素材"} value={id} disabled={busy} onChange={event => (i === 0 ? setLeftId : setRightId)(event.target.value)}>{candidates.filter(a => a.id !== (i === 0 ? rightId : leftId)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>)}</div>
      {first && second ? <>
        {first.kind === "video" && second.kind === "video" ? <SynchronizedVideos key={`${first.id}:${second.id}`} first={first} second={second} /> : <div className="comparison-panes">{[first, second].map(asset => <figure key={asset.id}>{asset.kind === "image" ? <img src={asset.url} alt={asset.name} /> : <video src={asset.url} controls preload="metadata" />}<figcaption>{asset.name}</figcaption></figure>)}</div>}
        <div className="comparison-panes comparison-metadata">{[first, second].map(asset => <div key={asset.id}><span>{formatSize(asset.size)}{asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ""}</span>
          {sameStack && <button disabled={busy || asset.status === "final"} onClick={async () => {
            setBusy(true); setError("");
            try { await onStackAction({ type: "final", id: asset.id, value: true }); }
            catch (reason) { setError((reason as Error).message); }
            finally { setBusy(false); }
          }}>{asset.status === "final" ? "当前置顶版本" : "选此版本并置顶"}</button>}
        </div>)}</div>
      </> : <p className="feature-empty">至少选择两个可用的图片或视频。</p>}
      {error && <p className="feature-error" role="alert">{error}</p>}
    </div>
  </FeatureDialog>;
}
