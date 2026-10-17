import type { ThumbInfo } from "./api";

/** 便笺本体（笔记本里的数据）。与绳上的卡片独立：取下卡片不删便笺。 */
export interface Note {
  id: string;
  text: string;
  updatedAt: number; // 排序用（时间倒序）
  /** 置顶：固定到笔记本列表顶部 */
  pinned?: boolean;
}

export interface Item {
  id: string;
  path: string;
  name: string;
  kind: "image" | "folder" | "file" | "note" | "entry";
  thumb?: ThumbInfo;
  tilt: number; // 固定随机倾斜（±2.5°）
  index: number; // 挂上顺序
  source: "drag" | "clip"; // 来源：拖入 / 剪贴板
  /** 便笺卡片关联的便笺 id（kind === "note" 时必有） */
  noteId?: string;
  /** 便笺卡片当前正文（随编辑同步，另存为时按它落 txt） */
  text?: string;
}
