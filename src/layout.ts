// 布局数学 —— 与参考 Swift 项目 Layout.swift 对齐。
// 绳子：二次贝塞尔 y(x) = ropeTop + 4·sag·f·(1−f)，f = x/width。

export type SizeKey = "small" | "medium" | "large";

export const ROPE_TOP = 10;
export const PIN_ABOVE = 9.5; // 衣夹顶相对绳的偏移

export function scaleOf(size: SizeKey): number {
  return size === "small" ? 0.8 : size === "large" ? 1.35 : 1;
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
  // 基础下垂 + 20px：弧的最低点再往下 20px，端点不变
  return Math.min(30, width * 0.018) + 20;
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
