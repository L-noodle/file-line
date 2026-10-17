import type { CSSProperties } from "react";
import type { Item } from "../types";
import { cardWidth, noteCardHeight, photoMaxHeight, SizeKey } from "../layout";
import CardContent from "./CardContent";

// 折叠区：挂不下的卡片按普通卡片尺寸小角度叠放，滚轮滚动来移动可见窗口。
// 唤出晾衣绳时随面板滑入一起出现（与卡片/绳同一节奏，无单独浮现动画）。
export default function OverflowFan({
  items,
  x,
  size,
}: {
  items: Item[];
  x: number;
  size: SizeKey;
}) {
  const hasItems = items.length > 0;

  if (!hasItems) return null;

  // 叠放的卡片（最多 3 张，小角度错开模拟叠放）
  const stack = items.slice(-3).reverse();
  const angles = [-8, -2, 5];

  const style = {
    left: x,
    "--card-w": `${cardWidth(size)}px`,
    "--photo-h": `${photoMaxHeight(size)}px`,
  } as CSSProperties;

  return (
    <div className="fan-zone" style={style}>
      <div className="fan-stack" aria-label={`${items.length} 张已折叠`}>
        {stack.map((it, i) => {
          const ang = angles[(stack.length - 1 - i) % angles.length];
          // 便笺预览：纸面高度固定为绳上便笺卡的高度（--fan-h 传给 CSS），
          // 不随文字长短伸缩；其余卡片维持原来的内容自适应
          const isNote = it.kind === "note";
          return (
            <div
              className={"fan-card" + (isNote ? " fan-card-note" : "")}
              key={it.id}
              style={{
                transform: `rotate(${ang}deg) translateY(${Math.abs(ang) * 0.6}px)`,
                zIndex: i + 1,
                ...(isNote ? { ["--fan-h"]: `${noteCardHeight(size)}px` } : {}),
              }}
            >
              <CardContent item={it} />
            </div>
          );
        })}
        <div className="fan-badge">+{items.length}</div>
      </div>
    </div>
  );
}
