// 布局数学 —— 与参考 Swift 项目 Layout.swift 对齐。
// 绳子：二次贝塞尔 y(x) = ropeTop + 4·sag·f·(1−f)，f = x/width。

export type SizeKey = "small" | "medium" | "large";

export const ROPE_TOP = 10;
export const PIN_ABOVE = 9.5; // 衣夹顶相对绳的偏移

// rope-reveal 入场时序：卡片与折叠堆叠不播单独浮现动画，
// 跟随面板（含绳）一起滑入落下，保持同一节奏。
export const REVEAL_BASE = 200; // 面板滑入尾段：卡片接近到位，开始挂绳晃动

export function scaleOf(size: SizeKey): number {
  return size === "small" ? 0.6 : size === "large" ? 1.0 : 0.8;
}

export function photoMaxHeight(size: SizeKey): number {
  return Math.round(104 * scaleOf(size));
}

// 卡片文件名最多两行（.card-name 的 -webkit-line-clamp: 2）。第二行让卡片
// 比单行高出约 11px × 1.2 ≈ 13px，取 14 留余量。鼠标命中区与 Dock 感应区
// 必须同步加这段高度，否则鼠标落在第二行文字上时会被判在卡片外而穿透下去。
export const NAME_SECOND_LINE = 14;

export function cardWidth(size: SizeKey): number {
  return Math.round(150 * scaleOf(size));
}

export function spacing(size: SizeKey): number {
  return cardWidth(size) + 24;
}

// 条带窗口高度（也是鼠标钩子判定「在条带内」的边界）。必须容得下：
// 挂点 30.5（ROPE_TOP 10 + 最大下垂 30 - PIN_ABOVE 9.5）
// + (衣夹 26 - 重叠 8 + 卡片最高 ~photo-h+40) × Dock 最大放大 1.2。
// 余量不足时，鼠标移入放大后的卡片底部会被窗口裁掉（小档最紧张）。
// ⚠️ 与 src-tauri/src/lib.rs 的 panel_height() 必须保持一致。
export function panelHeight(size: SizeKey): number {
  return photoMaxHeight(size) + 118;
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

// ---------- Dock 式邻近放大（macOS Dock 风格） ----------
// 以鼠标 x 为中心，高斯衰减：距离 0 → 最大放大，邻居快速回落，远处不受影响。
// SIGMA 越小衰减越陡（邻居放大越少）；RANGE 为截断半径。
export const DOCK_MAX = 1.2; // 正下方卡片的最大放大倍数
export const DOCK_RANGE = 2.5; // 影响半径（间距倍数）
export const DOCK_SIGMA = 0.85; // 高斯衰减宽度（间距倍数）

export function dockScale(dist: number, spacingPx: number): number {
  const range = DOCK_RANGE * spacingPx;
  if (dist >= range) return 1;
  const sigma = DOCK_SIGMA * spacingPx;
  const f = Math.exp(-((dist / sigma) * (dist / sigma)));
  return 1 + (DOCK_MAX - 1) * f;
}
