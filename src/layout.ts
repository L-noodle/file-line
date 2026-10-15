// 布局数学 —— 与参考 Swift 项目 Layout.swift 对齐。
// 绳子：二次贝塞尔 y(x) = ropeTop + 4·sag·f·(1−f)，f = x/width。

export type SizeKey = "small" | "medium" | "large";

export const ROPE_TOP = 10;
export const PIN_ABOVE = 9.5; // 衣夹顶相对绳的偏移

// rope-reveal 入场时序：卡片从左到右"由快转慢"地浮现——
// 左侧卡片挨得紧、出现节奏快，越往右间隔越大、节奏放缓（pow 1.5 分布）。
// 左右折叠堆叠复用同一时间轴（左堆叠最先、右堆叠最后）。
export const REVEAL_BASE = 200; // 首张卡片延迟（等面板滑入尾段）
export const REVEAL_SPAN = 340; // 全部卡片错峰的总时长（count ≥ 2）
export const REVEAL_DUR = 220; // 单张浮现动画时长

/** 第 index 张卡片的错峰延迟：前密后疏，由快转慢。 */
export function revealStagger(index: number, count: number): number {
  if (count <= 1) return 0;
  return Math.pow(index / (count - 1), 1.5) * REVEAL_SPAN;
}

export function scaleOf(size: SizeKey): number {
  return size === "small" ? 0.6 : size === "large" ? 1.0 : 0.8;
}

export function photoMaxHeight(size: SizeKey): number {
  return Math.round(104 * scaleOf(size));
}

export function cardWidth(size: SizeKey): number {
  return Math.round(150 * scaleOf(size));
}

export function spacing(size: SizeKey): number {
  return cardWidth(size) + 24;
}

export function panelHeight(size: SizeKey): number {
  return photoMaxHeight(size) + 106;
}

export function sag(width: number): number {
  // 基础下垂（限制最大 30px），弧度平缓
  return Math.min(30, width * 0.018);
}

export function ropeY(x: number, width: number): number {
  const f = x / width;
  return ROPE_TOP + 4 * sag(width) * f * (1 - f);
}

/** 可见卡片数：两侧各留白后按间距铺开。 */
export function visibleCapacity(width: number, size: SizeKey): number {
  const s = spacing(size);
  return Math.max(3, Math.floor((width - 200) / s));
}

/** 第 index 张可见卡片的中心 x（可见区整体居中）。 */
export function visibleX(
  index: number,
  count: number,
  width: number,
  size: SizeKey
): number {
  const s = spacing(size);
  return width / 2 + (index - (count - 1) / 2) * s;
}
