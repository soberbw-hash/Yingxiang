import { useEffect, useRef, type ReactNode } from "react";
import { X, MusicNote } from "@phosphor-icons/react";
import type { Asset } from "../types";
import "./features.css";

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
export function FeatureDialog({
  title,
  onClose,
  children,
  wide = false,
  busy = false,
  className = "",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  busy?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    dialog
      ?.querySelector<HTMLTextAreaElement>(
        ".editing-paste textarea,.import-naming input,.navigator-search input",
      )
      ?.focus();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`feature-dialog${wide ? " feature-dialog-wide" : ""} ${className}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <header className="feature-dialog-header">
        <h2>{title}</h2>
        <button
          type="button"
          className="feature-icon"
          aria-label="关闭"
          onClick={onClose}
          disabled={busy}
        >
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function AssetMedia({ asset }: { asset: Asset }) {
  if (!asset.url)
    return <span className="feature-unavailable">预览不可用</span>;
  if (asset.kind === "image")
    return <img src={asset.url} alt={asset.name} loading="lazy" />;
  if (asset.kind === "video")
    return <video src={asset.url} preload="metadata" muted />;
  if (asset.kind === "audio")
    return (
      <span className="feature-unavailable">
        <MusicNote size={24} /> 音频
      </span>
    );
  return <span className="feature-unavailable">文档 · {asset.name}</span>;
}
