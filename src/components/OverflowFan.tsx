import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { Item } from "../types";
import { cardWidth, photoMaxHeight, SizeKey, REVEAL_DUR } from "../layout";
import CardContent from "./CardContent";

// 折叠区：挂不下的卡片按普通卡片尺寸小角度叠放，滚轮滚动来移动可见窗口。
// revealDelay：唤出晾衣绳时的入场延迟（左侧最先 / 右侧等所有卡片浮现完）。
export default function OverflowFan({
  items,
  x,
  size,
  revealDelay,
}: {
  items: Item[];
  x: number;
  size: SizeKey;
  revealDelay: number;
}) {
  const zoneRef = useRef<HTMLDivElement>(null);
  const hasItems = items.length > 0;

  // 入场：与卡片共用 rope-reveal 时间轴，按侧别给定的延迟浮现
  useEffect(() => {
    const el = zoneRef.current;
    if (!el) return;
    const onReveal = () => {
      el.animate(
        [
          { opacity: 0, transform: "translateY(-14px) scale(0.96)" },
          { opacity: 1, transform: "translateY(0) scale(1)" },
        ],
        {
          duration: REVEAL_DUR,
          delay: revealDelay,
          easing: "cubic-bezier(0.2, 0.9, 0.3, 1.1)",
          fill: "backwards", // delay 期间保持初始帧（隐藏）
        },
      );
    };
    window.addEventListener("rope-reveal", onReveal);
    return () => window.removeEventListener("rope-reveal", onReveal);
  }, [revealDelay, hasItems]);

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
    <div className="fan-zone" style={style} ref={zoneRef}>
      <div className="fan-stack" aria-label={`${items.length} 张已折叠`}>
        {stack.map((it, i) => {
          const ang = angles[(stack.length - 1 - i) % angles.length];
          return (
            <div
              className="fan-card"
              key={it.id}
              style={{
                transform: `rotate(${ang}deg) translateY(${Math.abs(ang) * 0.6}px)`,
                zIndex: i + 1,
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
