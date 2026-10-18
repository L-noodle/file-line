import { invoke } from "@tauri-apps/api/core";

export interface ThumbInfo {
  kind: "image" | "folder" | "file";
  w: number;
  h: number;
  b64: string;
  icon: string;
  error?: string;
}

/** 持久化卡片：文件卡片带 path，便笺卡片只带 noteId，待办卡片只带 todoId */
export type SavedItem =
  | { path: string; source: "drag" | "clip" }
  | { noteId: string }
  | { todoId: string };

/** 另存为时落地的便笺 txt */
export interface NoteFile {
  name: string; // 不含扩展名
  text: string;
}

interface SavedNote {
  id: string;
  text: string;
  updatedAt: number;
  createdAt?: number;
  pinned?: boolean;
}

export interface SavedTodo {
  id: string;
  title: string;
  text: string;
  startAt: number;
  endAt: number;
  repeat: boolean;
  remindStart: number | null;
  remindEnd: number | null;
  done: boolean;
  updatedAt: number;
  createdAt?: number;
  pinned?: boolean;
}

export const api = {
  getState: () =>
    invoke<{
      items: SavedItem[];
      size: string | null;
      notes?: SavedNote[];
      todos?: SavedTodo[];
    }>("get_state"),
  saveState: (items: SavedItem[], notes: SavedNote[], todos: SavedTodo[]) =>
    invoke<void>("save_state", { items, notes, todos }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  showInFolder: (path: string) => invoke<void>("show_in_folder", { path }),
  saveToFolder: (paths: string[], folder: string, notes: NoteFile[]) =>
    invoke<string>("save_to_folder", { paths, folder, notes }),
  copyToClipboard: (path: string) => invoke<void>("copy_to_clipboard", { path }),
  /** 便笺：把正文作为纯文本写进剪贴板 */
  copyText: (text: string) => invoke<void>("copy_text_to_clipboard", { text }),
  /** 便笺：把正文作为纯文本拖出（Windows；macOS 走 drag 插件的 Data 拖放） */
  dragText: (text: string) => invoke<void>("drag_text", { text }),
  setHitRects: (
    rects: [number, number, number, number][],
    panelH: number,
    scrollable: boolean
  ) => invoke<void>("set_hit_rects", { rects, panelH, scrollable }),
  showRope: () => invoke<void>("show_rope"),
  hideRope: () => invoke<void>("hide_rope"),
  /** 待办提醒：只显示窗口（不唤出绳子），仅展示提醒消息本身 */
  showReminderWindow: () => invoke<void>("show_reminder_window"),
  activateApp: () => invoke<void>("activate_app"),
  makeThumb: (path: string, maxPx: number) =>
    invoke<ThumbInfo>("make_thumb", { path, maxPx }),
  requestMacPermission: () => invoke<boolean>("request_mac_permission"),
};
