import { useEffect, useRef } from "react";
import Clothespin from "./Clothespin";
import { Spring } from "../spring";
import {
  entryCardWidth,
  REVEAL_BASE,
  ropeY,
  PIN_ABOVE,
  SizeKey,
} from "../layout";

interface Props {
  width: number;
  size: SizeKey;
  x: number;
  tilt: number;
  zIndex: number;
  /** 左图（便笺）：新增便笺 */
  onNote: (e: React.MouseEvent) => void;
  /** 右图（笔记本）：打开便笺管理器 */
  onNotebook: (e: React.MouseEvent) => void;
}

// 便笺管理入口卡片：与普通卡片同款视觉（衣夹 + 白边玻璃卡），
// 卡面内左右两张图（便笺 / 笔记本）。常驻绳尾，只响应点击：
// 不支持右键（吞掉原生菜单）、不能拖动 / 重排 / 取下。
export default function EntryCard({
  width,
  size,
  x,
  tilt,
  zIndex,
  onNote,
  onNotebook,
}: Props) {
  const rotRef = useRef<HTMLDivElement>(null);
  const springRef = useRef<Spring | null>(null);

  // 入场摆动 + 阵风 + 揭幕（与普通卡片同一节奏）
  useEffect(() => {
    const el = rotRef.current;
    if (!el) return;
    const spring = new Spring(
      16,
      (v) => {
        el.style.transform = `rotate(${(tilt + v).toFixed(3)}deg)`;
      },
      46,
      2.6
    );
    springRef.current = spring;
    const t = window.setTimeout(() => spring.to(0), 30);
    const onGust = (e: Event) => {
      const d = (e as CustomEvent<number>).detail;
      spring.nudge(d * (Math.random() > 0.5 ? 1 : -1));
    };
    window.addEventListener("gust", onGust);
    let revealTimer = 0;
    const onReveal = () => {
      revealTimer = window.setTimeout(() => {
        spring.nudge((28 + Math.random() * 14) * (Math.random() > 0.5 ? 1 : -1));
      }, REVEAL_BASE);
    };
    window.addEventListener("rope-reveal", onReveal);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(revealTimer);
      window.removeEventListener("gust", onGust);
      window.removeEventListener("rope-reveal", onReveal);
      spring.destroy();
    };
  }, [tilt]);

  const cw = entryCardWidth(size);
  const pinY = ropeY(x, width) - PIN_ABOVE;

  return (
    <div
      className="pegged-slot entry-slot"
      data-x={x}
      style={{
        left: x - cw / 2,
        top: pinY,
        ["--card-w" as string]: `${cw}px`,
        zIndex,
      }}
    >
      <div className="pegged-dock">
        <div className="pegged-rot" ref={rotRef}>
          <Clothespin />
          <div
            className="card entry-card"
            onContextMenu={(e) => e.preventDefault()}
          >
            <div className="entry-imgs">
              <div
                className="entry-img-btn"
                title="新增便笺"
                onClick={onNote}
              >
                <img src="/note.png" alt="新增便笺" draggable={false} />
              </div>
              <div
                className="entry-img-btn"
                title="打开笔记本"
                onClick={onNotebook}
              >
                <img src="/notebook.png" alt="打开笔记本" draggable={false} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
