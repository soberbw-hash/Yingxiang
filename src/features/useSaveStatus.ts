import { useEffect, useState } from "react";
export function useSaveStatus() {
  const [state, setState] = useState({ pending: 0, failed: 0 });
  useEffect(() => {
    const root = document.querySelector(".workspace");
    if (!root) return;
    const read = () => {
      const pending = root.querySelectorAll('[data-editing-dirty="true"]').length;
      const failed = root.querySelectorAll('[data-save-state="error"]').length;
      setState(previous => previous.pending === pending && previous.failed === failed ? previous : { pending, failed });
    };
    const observer = new MutationObserver(read);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-editing-dirty", "data-save-state"] });
    read(); return () => observer.disconnect();
  }, []);
  return state;
}
