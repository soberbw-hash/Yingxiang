import { useEffect, useRef, useState } from "react";
import type { Asset, CanvasDocument } from "../../types";
import { emptyCanvas, validateCanvas } from "../../../shared/canvas.mjs";

export function useCanvasDocument(
  stored: CanvasDocument | undefined,
  assets: Asset[],
  onSave: (doc: CanvasDocument, revision: number) => Promise<CanvasDocument>,
  isVisible = true,
) {
  const [doc, setDoc] = useState(() => stored ? validateCanvas(stored, assets) : emptyCanvas());
  const current = useRef(doc), saved = useRef(stored), active = useRef(true);
  const latestAssets = useRef(assets);
  latestAssets.current = assets;
  const past = useRef<CanvasDocument[]>([]), future = useRef<CanvasDocument[]>([]);
  const [saving, setSaving] = useState(false), savingRef = useRef(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  current.current = doc;
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    if (savingRef.current || dirty || !stored || stored.revision === saved.current?.revision) return;
    saved.current = stored;
    current.current = validateCanvas(stored, assets);
    setDoc(current.current);
    past.current = []; future.current = [];
  }, [stored, dirty, assets]);
  useEffect(() => {
    if (!isVisible || (!dirty && !saving)) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, saving, isVisible]);
  async function persist(next: CanvasDocument, remember = true, validationAssets = latestAssets.current) {
    if (savingRef.current) return false;
    const previous = current.current;
    const revision = saved.current?.revision || 0;
    const proposal = validateCanvas({ ...next, revision }, validationAssets);
    current.current = proposal; setDoc(proposal);
    savingRef.current = true; setSaving(true); setDirty(true); setError("");
    try {
      const result = await onSave(proposal, revision);
      saved.current = result;
      if (!active.current) return true;
      current.current = result; setDoc(result); setDirty(false);
      if (remember) { past.current.push(previous); past.current = past.current.slice(-50); future.current = []; }
      return true;
    } catch (reason) {
      if (active.current) setError((reason as Error).message);
      return false;
    } finally {
      savingRef.current = false;
      if (active.current) setSaving(false);
    }
  }
  async function undo() {
    const previous = past.current[past.current.length - 1]; if (!previous || savingRef.current || dirty) return;
    const before = current.current;
    if (await persist(previous, false)) { past.current.pop(); future.current.push(before); setDoc({ ...current.current }); }
  }
  async function redo() {
    const next = future.current[future.current.length - 1]; if (!next || savingRef.current || dirty) return;
    const before = current.current;
    if (await persist(next, false)) { future.current.pop(); past.current.push(before); setDoc({ ...current.current }); }
  }
  function reload() {
    if (!window.confirm("放弃未保存的画布布局，载入项目中的已保存布局？素材原文件不受影响。")) return;
    saved.current = stored;
    const next = stored ? validateCanvas(stored, assets) : emptyCanvas();
    current.current = next; setDoc(next); setDirty(false); setError("");
    past.current = []; future.current = [];
  }
  return { doc, current, persist, undo, redo, reload, saving, dirty, error,
    canUndo: past.current.length > 0 && !dirty, canRedo: future.current.length > 0 && !dirty };
}
