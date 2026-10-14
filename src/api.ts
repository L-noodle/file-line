import { invoke } from "@tauri-apps/api/core";

export interface ThumbInfo {
  kind: "image" | "folder" | "file";
  w: number;
  h: number;
  b64: string;
  icon: string;
  error?: string;
}

export interface SavedItem {
  path: string;
  source: "drag" | "clip";
}

export const api = {
  getState: () => invoke<{ items: SavedItem[]; size: string | null }>("get_state"),
  saveState: (items: SavedItem[]) => invoke<void>("save_state", { items }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  showInFolder: (path: string) => invoke<void>("show_in_folder", { path }),
  saveToFolder: (paths: string[], folder: string) =>
    invoke<string>("save_to_folder", { paths, folder }),
  copyToClipboard: (path: string) => invoke<void>("copy_to_clipboard", { path }),
  setHitRects: (
    rects: [number, number, number, number][],
    panelH: number
  ) => invoke<void>("set_hit_rects", { rects, panelH }),
  showRope: () => invoke<void>("show_rope"),
  hideRope: () => invoke<void>("hide_rope"),
  makeThumb: (path: string, maxPx: number) =>
    invoke<ThumbInfo>("make_thumb", { path, maxPx }),
};
