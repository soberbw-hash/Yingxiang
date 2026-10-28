import { useLayoutEffect, useRef, type RefObject } from "react";
import { originalRowSpan } from "../services/libraryLayout";

/** One observer per grid; intrinsic card heights remain independent of row spans. */
export function useOriginalGrid(
  ref: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  ids: string,
) {
  const initializedGrid = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    if (!enabled) {
      Array.from(grid.children).forEach(card => (card as HTMLElement).style.removeProperty("grid-row-end"));
      return;
    }
    const cards = Array.from(grid.children) as HTMLElement[];
    let frame = 0;
    const measure = () => {
      const css = getComputedStyle(grid);
      const row = parseFloat(css.gridAutoRows) || 1,
        gap = parseFloat(css.rowGap) || 0;
      const spans = cards.map((card) =>
        originalRowSpan(card.getBoundingClientRect().height, row, gap),
      );
      cards.forEach((card, i) => {
        const next = `span ${spans[i]}`;
        if (card.style.gridRowEnd !== next) card.style.gridRowEnd = next;
      });
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    cards.forEach((card) => observer.observe(card));
    measure();
    let timeout: number | undefined;
    let mutations: MutationObserver | undefined;
    if (initializedGrid.current !== grid) {
      initializedGrid.current = grid;
      grid.dataset.layoutSettling = "true";
      const reveal = () => { delete grid.dataset.layoutSettling; mutations?.disconnect(); if (timeout !== undefined) window.clearTimeout(timeout); };
      const check = () => {
        // Lazy off-screen thumbnails must not delay the visible part of the grid.
        const visibleBottom = (grid.closest(".library-scroll")?.getBoundingClientRect().bottom || window.innerHeight) + 100;
        if (!cards.some(card => card.dataset.ratioPending && card.getBoundingClientRect().top < visibleBottom)) reveal();
      };
      mutations = new MutationObserver(check);
      mutations.observe(grid, { subtree: true, attributes: true, attributeFilter: ["data-ratio-pending"] });
      timeout = window.setTimeout(reveal, 700);
      check();
    }
    return () => {
      cancelAnimationFrame(frame);
      mutations?.disconnect();
      if (timeout !== undefined) window.clearTimeout(timeout);
      delete grid.dataset.layoutSettling;
      observer.disconnect();
    };
  }, [ref, enabled, ids]);
}
