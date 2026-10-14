import type { ThumbInfo } from "./api";

export interface Item {
  id: string;
  path: string;
  name: string;
  kind: "image" | "folder" | "file";
  thumb?: ThumbInfo;
  tilt: number; // 固定随机倾斜（±2.5°）
  index: number; // 挂上顺序
  source: "drag" | "clip"; // 来源：拖入 / 剪贴板
}
