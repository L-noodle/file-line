// 布局数学 —— 与参考 Swift 项目 Layout.swift 对齐。
// 绳子：二次贝塞尔 y(x) = ropeTop + 4·sag·f·(1−f)，f = x/width。

import type { Item } from "./types";

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

/** 相邻卡片边缘间隙（中心距 = 半宽和 + 间隙）。宽卡片与普通卡的视觉间距因此一致 */
export const CARD_GAP = 24;

/** 标准卡（普通文件卡）的中心距 = 卡宽 + 间隙。滚轮滚动单位 / Dock 感应半径用它；
 *  实际绳上位置由 pitchBetween / visibleCenters 按各卡真实宽度计算。 */
export function spacing(size: SizeKey): number {
  return cardWidth(size) + CARD_GAP;
}

/** 卡片宽度（按类型）：普通 / 便笺 / 待办 / 倒计时 / 便笺管理入口 */
export function itemWidth(kind: Item["kind"], size: SizeKey): number {
  if (kind === "note") return noteCardWidth(size);
  if (kind === "todo") return todoCardWidth(size);
  if (kind === "countdown") return countdownCardWidth(size);
  if (kind === "entry") return entryCardWidth(size);
  return cardWidth(size);
}

/** 相邻两张卡片的中心距（半宽和 + 固定间隙；宽卡片不再显得离邻居更近） */
export function pitchBetween(
  a: Item["kind"],
  b: Item["kind"],
  size: SizeKey
): number {
  return (itemWidth(a, size) + itemWidth(b, size)) / 2 + CARD_GAP;
}

// ---------- 便笺卡片 ----------
// 比普通卡片大一圈（正文要看得清），但必须给邻居留出身位：
// 邻居放大到 DOCK_MAX 时半宽为 0.6·cardWidth，故要求
//   noteWidth / 2 + 0.6·cardWidth ≤ spacing = cardWidth + 24
// → noteWidth ≤ 0.8·cardWidth + 48。这里再留约 8px 呼吸位（0.78 + 40），
// 保证鼠标移入邻居放大时也不会和便笺叠在一起。
// 便笺自身也参与 Dock 放大，上限 WIDE_DOCK_MAX（1.12）——
// 低于普通卡的 DOCK_MAX，扫过邻居时两者不会贴上（入口卡片同理）。
export function noteCardWidth(size: SizeKey): number {
  const cw = cardWidth(size);
  return Math.round(Math.min(cw * 1.3, cw * 0.78 + 40));
}

export function noteCardHeight(size: SizeKey): number {
  return Math.round(photoMaxHeight(size) * 0.9 + 20);
}

// ---------- 便笺管理入口卡片 ----------
// 常驻绳尾（最右）的入口卡片：卡面内三张图（便笺 / 待办 / 笔记本），
// 两行摆放（便笺 + 待办在第一行，笔记本被挤到第二行）。
// 宽度在便笺卡片公式基础上再收窄 10px——三图两行后观感更紧凑，
// 同时仍满足不给 Dock 放大的邻居压到（比便笺更窄，约束更宽松）。
export function entryCardWidth(size: SizeKey): number {
  return noteCardWidth(size) - 10;
}

// 入口卡单张图的显示高度：半宽 × 便笺素材高宽比（217 / 191）再减 14px
// 呼吸位，并钳到条带窗口容量内——三张图两行摆放后卡更高，命中区口径
// （26 + 卡高×1.12 + 36）不得超出窗口，否则大档下卡片底部被窗口裁掉、
// 命中区还会吞掉窗口外的点击。
// ⚠️ 按便笺卡宽度（noteCardWidth）推导而非 entryCardWidth：入口卡整体
// 收窄 10px 时只收卡体，图标大小与卡片高度保持不变（收窄后每格仍放得下）
export function entryImgHeight(size: SizeKey): number {
  const natural = ((noteCardWidth(size) - 34) / 2) * (217 / 191) - 14;
  // 卡高 = 2×图高 + 行间距 8 + 木框 26 → 图高 ≤ (命中区上限 − 34) / 2
  const cap = (panelHeight(size) - 62) / 1.12 / 2 - 17;
  return Math.max(20, Math.min(natural, cap));
}

// 高度 = 木框 + 相纸内衬 + 两行图高 + 行间距。
// 每行两格，格宽 = (卡宽 - 木框相纸 26 - 图间距 8) / 2；
// 三张图统一按 entryImgHeight 的高度摆放（横版的笔记本图同高居中，
// 宽度自然更窄）。--card-w 口径与 .entry-card / .entry-imgs 的
// padding（木框 8 + 相纸 5、图间距 8）对齐
export function entryCardHeight(size: SizeKey): number {
  const framePad = (8 + 5) * 2;
  return Math.round(entryImgHeight(size) * 2 + 8 + framePad);
}

// ---------- 待办卡片 ----------
// 展示标题 + 内容预览：宽度与便笺同口径（同一套 Dock 放大约束），
// 高度在便笺基础上再留出标题与几行内容的余量
export function todoCardWidth(size: SizeKey): number {
  return noteCardWidth(size);
}

export function todoCardHeight(size: SizeKey): number {
  return Math.round(noteCardHeight(size) * 1.05);
}

// ---------- 倒计时卡片 ----------
// 展示名称 + 内容 + 底部倒计时条：宽度与待办同口径；高度也与待办一致，
// 倒计时条占用上方内容预览的区域（卡面不再额外加高）
export function countdownCardWidth(size: SizeKey): number {
  return todoCardWidth(size);
}

export function countdownCardHeight(size: SizeKey): number {
  return todoCardHeight(size);
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

/**
 * 可见卡片数：从绳尾（最右）向前按各卡实际宽度累计，两侧各留 100px 白边。
 * 便笺 / 入口卡更宽，同样屏宽下放下的张数会略少——按真实宽度算才不越界。
 */
export function visibleCapacity(
  kinds: Item["kind"][],
  width: number,
  size: SizeKey
): number {
  const budget = width - 200;
  let used = -CARD_GAP;
  let n = 0;
  for (let i = kinds.length - 1; i >= 0; i--) {
    const w = itemWidth(kinds[i], size);
    const next = used + (n > 0 ? CARD_GAP : 0) + w;
    // 至少保底一张（与旧行为一致：max(3, …) 兜底窄屏）
    if (n > 0 && next > budget) break;
    used = next;
    n++;
  }
  return Math.max(3, n);
}

/**
 * 可见卡片的中心 x 列表：按各自实际宽度铺开（相邻边缘留 CARD_GAP），整体居中。
 * 取代旧的等距 visibleX——宽卡片与普通卡的间隙从此一致。
 */
export function visibleCenters(
  kinds: Item["kind"][],
  width: number,
  size: SizeKey
): number[] {
  const n = kinds.length;
  if (n === 0) return [];
  let total = -CARD_GAP;
  for (const k of kinds) total += itemWidth(k, size) + CARD_GAP;
  let x = (width - total) / 2;
  return kinds.map((k) => {
    const w = itemWidth(k, size);
    const c = x + w / 2;
    x += w + CARD_GAP;
    return c;
  });
}

// ---------- 卡片悬停放大 ----------
// 鼠标悬停在哪张卡上就放大哪张，邻居不联动。
export const DOCK_MAX = 1.1; // 普通卡片悬停时的最大放大倍数

/** 宽卡片（便笺 / 待办 / 倒计时 / 入口卡）的放大上限：1.08（普通卡为 DOCK_MAX 1.15）。
 *  这份反馈不能没有：CSS :hover 在点击穿透态收不到鼠标事件，
 *  只有钩子转发的 --dock 变量能驱动动画（其它卡片的悬浮感也来自它）。
 *  上限压低是为了放大后不压到相邻卡片（宽卡本身放大过大会明显挤占 CARD_GAP）。 */
export const WIDE_DOCK_MAX = 1.08;
