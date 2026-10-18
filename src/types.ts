import type { ThumbInfo } from "./api";

/** 便笺本体（笔记本里的数据）。与绳上的卡片独立：取下卡片不删便笺。 */
export interface Note {
  id: string;
  text: string;
  updatedAt: number; // 排序用（时间倒序）
  /** 创建时间（全部 / 便笺 / 待办 混排按它穿插展示） */
  createdAt?: number;
  /** 置顶：固定到笔记本列表顶部 */
  pinned?: boolean;
}

/** 待办：带标题 / 时间 / 提醒的待办事项。与便笺一样，独立于绳上的卡片 */
export interface Todo {
  id: string;
  title: string;
  text: string; // 内容
  /** 开始时间（ms 时间戳；0 = 未设置） */
  startAt: number;
  /** 结束时间（ms 时间戳；0 = 未设置） */
  endAt: number;
  /** 是否重复（每天同一时间再次提醒） */
  repeat: boolean;
  /** 开始前提醒（分钟；null = 不提醒） */
  remindStart: number | null;
  /** 结束前提醒（分钟；null = 不提醒） */
  remindEnd: number | null;
  /** 已完成 */
  done: boolean;
  updatedAt: number;
  createdAt?: number;
  /** 置顶（已完成的待办会被强制取消置顶） */
  pinned?: boolean;
}

export interface Item {
  id: string;
  path: string;
  name: string;
  kind: "image" | "folder" | "file" | "note" | "entry" | "todo";
  thumb?: ThumbInfo;
  tilt: number; // 固定随机倾斜（±2.5°）
  index: number; // 挂上顺序
  source: "drag" | "clip"; // 来源：拖入 / 剪贴板
  /** 便笺卡片关联的便笺 id（kind === "note" 时必有） */
  noteId?: string;
  /** 便笺卡片当前正文（随编辑同步，另存为时按它落 txt） */
  text?: string;
  /** 待办卡片关联的待办 id（kind === "todo" 时必有） */
  todoId?: string;
}
