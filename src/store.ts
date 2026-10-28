import { create } from "zustand";
import { invoke, isDesktop } from "./services/api";
import { notifyBrowserTask } from "./services/browserNotifications";
import type { Bootstrap, ProjectSnapshot, Settings, Project } from "./types";

const defaults: Settings = {
  displayName: "创作者",
  inboxPath: "",
  receiveProjectId: "",
  receiveShotId: "",
  notifications: false,
  background: false,
};
type State = {
  projects: Project[];
  snapshot?: ProjectSnapshot;
  settings: Settings;
  loading: boolean;
  busy: boolean;
  error: string;
  warning: string;
  refresh: () => Promise<void>;
  run: (method: string, payload?: Record<string, unknown>) => Promise<any>;
  clearError: () => void;
};
let queue: Promise<unknown> = Promise.resolve();
export const useWorkspace = create<State>((set, get) => ({
  projects: [],
  settings: defaults,
  loading: true,
  busy: false,
  error: "",
  warning: "",
  clearError: () => set({ error: "", warning: "" }),
  refresh: async () => {
    try {
      const data: Bootstrap = await invoke("bootstrap");
      set({
        projects: data.projects || [],
        snapshot: data.snapshot,
        settings: { ...defaults, ...data.settings },
        loading: false,
        warning: data.warning || "",
      });
    } catch (error) {
      set({ loading: false, error: String((error as Error).message || error) });
      throw error;
    }
  },
  run: (method, payload = {}) => {
    const work = async () => {
      set({ busy: true, error: "" });
      try {
        const result = await invoke(method, payload);
        await get().refresh();
        if (result?.directoryWarning) set({ warning: result.directoryWarning });
        if (!isDesktop)
          notifyBrowserTask(method, result, true);
        return result;
      } catch (error) {
        if (!isDesktop)
          notifyBrowserTask(
            method,
            undefined,
            true,
            true,
          );
        set({ error: String((error as Error).message || error) });
        await get()
          .refresh()
          .catch(() => {});
        throw error;
      } finally {
        set({ busy: false });
      }
    };
    const task = queue.then(work, work);
    queue = task.catch(() => {});
    return task;
  },
}));
