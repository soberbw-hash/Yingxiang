export type WorkspaceResume = { view: "library" | "shots"; search: string; filter: string };
export type SavedLibrarySearch = { id: string; name: string; search: string; category: string; kind: string; favorites: boolean; sort: string };
export function readPreference<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
export function writePreference(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
export function readResume(projectId: string): WorkspaceResume {
  const value = readPreference<any>(`weave.resume.${projectId}`, {});
  return { view: value?.view === "shots" ? "shots" : "library",
    search: typeof value?.search === "string" ? value.search.slice(0, 1000) : "",
    filter: value?.filter === "prop" ? "uncategorized" : ["all", "uncategorized", "product", "character", "scene", "storyboard", "script", "video", "audio", "other"].includes(value?.filter) ? value.filter : "all" };
}
export function readFavorites(projectId: string): string[] {
  const raw = readPreference<unknown>(`weave.favorites.${projectId}`, []);
  return Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === "string" && id.length <= 100))].slice(0, 10000) : [];
}
export function readSavedSearches(projectId: string): SavedLibrarySearch[] {
  const raw = readPreference<unknown>(`weave.searches.${projectId}`, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is SavedLibrarySearch => x && typeof x.id === "string" && typeof x.name === "string" && typeof x.search === "string" && typeof x.category === "string" &&
    ["all", "image", "video", "audio", "document"].includes(x.kind) && typeof x.favorites === "boolean" &&
    ["recent", "oldest", "name", "type", "custom"].includes(x.sort)).slice(0, 20);
}
export type ScrollBookmark = { top: number; anchor: string; offset: number; index: number };
export function readScrollBookmark(key: string): ScrollBookmark | undefined {
  const value = readPreference<any>(`weave.scroll.${key}`, null);
  return value && Number.isFinite(value.top) && value.top >= 0 && typeof value.anchor === "string" &&
    Number.isFinite(value.offset) && Number.isInteger(value.index) && value.index >= 0 ? value : undefined;
}
