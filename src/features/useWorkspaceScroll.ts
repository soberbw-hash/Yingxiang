import { useLayoutEffect, type RefObject } from "react";
import { readScrollBookmark, writePreference, type ScrollBookmark } from "../services/workspacePreferences";

/** Keep an item anchor as well as pixels so intrinsic media sizes can settle. */
export function useWorkspaceScroll(ref: RefObject<HTMLElement | null>, key: string, active: boolean, contentKey: string) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    let last: ScrollBookmark | undefined = readScrollBookmark(key), frame = 0, restoring = true, touched = false;
    const items = () => Array.from(element.querySelectorAll<HTMLElement>("[data-paragraph-id],.asset-card[data-preview-asset]"));
    const id = (node: HTMLElement) => node.dataset.paragraphId || node.dataset.previewAsset || "";
    const capture = () => {
      if (!element.clientHeight) return;
      const list = items(), top = element.getBoundingClientRect().top;
      const index = list.findIndex(node => node.getBoundingClientRect().bottom > top);
      const node = list[Math.max(0, index)];
      last = { top: element.scrollTop, anchor: node ? id(node) : "", offset: node ? node.getBoundingClientRect().top - top : 0, index: Math.max(0, index) };
      writePreference(`weave.scroll.${key}`, last);
    };
    const restore = () => {
      if (!last || touched) return;
      const node = items().find(node => id(node) === last!.anchor);
      element.scrollTop = node ? element.scrollTop + node.getBoundingClientRect().top - element.getBoundingClientRect().top - last.offset : last.top;
    };
    const interacted = () => { touched = true; restoring = false; };
    const scrolled = () => { if (restoring) return; cancelAnimationFrame(frame); frame = requestAnimationFrame(capture); };
    const loaded = () => { if (!touched) { restoring = true; restore(); cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { restoring = false; }); } };
    restore();
    frame = requestAnimationFrame(() => { restore(); restoring = false; });
    element.addEventListener("scroll", scrolled, { passive: true });
    element.addEventListener("wheel", interacted, { passive: true });
    element.addEventListener("pointerdown", interacted);
    element.addEventListener("keydown", interacted);
    element.addEventListener("load", loaded, true);
    const flush = () => { if (!restoring && element.clientHeight) capture(); else if (last) writePreference(`weave.scroll.${key}`, last); };
    window.addEventListener("pagehide", flush);
    return () => {
      cancelAnimationFrame(frame);
      // React may have replaced a filter's children before cleanup runs.
      if (last) writePreference(`weave.scroll.${key}`, last);
      element.removeEventListener("scroll", scrolled); element.removeEventListener("wheel", interacted);
      element.removeEventListener("pointerdown", interacted); element.removeEventListener("keydown", interacted);
      element.removeEventListener("load", loaded, true); window.removeEventListener("pagehide", flush);
    };
  }, [ref, key, active, contentKey]);
}
