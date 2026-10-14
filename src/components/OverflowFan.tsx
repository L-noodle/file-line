import { useState } from "react";
import type { Item } from "../types";

// 折叠区：挂不下的旧卡片叠成小扇；hover 展开 tooltip（顶部小箭头 + 动画）。
export default function OverflowFan({
  items,
  x,
  onOpen,
}: {
  items: Item[];
  x: number;
  onOpen: (item: Item) => void;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;

  // 叠加的迷你卡片（最多 3 张，旋转错开）
  const stack = items.slice(-3).reverse();
  const angles = [-13, -1, 11];

  return (
    <div
      className={"fan-zone" + (open ? " open" : "")}
      style={{ left: x }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <div className="fan-stack" role="button" aria-label={`${items.length} 张已折叠`}>
        {stack.map((it, i) => {
          const ang = angles[(stack.length - 1 - i) % angles.length];
          return (
            <div
              className="fan-card glass"
              key={it.id}
              style={{ transform: `rotate(${ang}deg) translateY(${Math.abs(ang) * 0.5}px)` }}
            >
              {it.thumb?.b64 ? (
                <img src={`data:image/png;base64,${it.thumb.b64}`} alt="" draggable={false} />
              ) : (
                <div className={"fan-glyph " + (it.thumb?.kind ?? "file")}>
                  {it.thumb?.kind === "folder" ? "📁" : "📄"}
                </div>
              )}
            </div>
          );
        })}
        <div className="fan-badge">+{items.length}</div>
      </div>

      {open && (
        <div className="fan-tooltip glass-strong">
          <div className="fan-arrow" />
          <div className="fan-title">已折叠 {items.length} 项</div>
          <div className="fan-list">
            {items.map((it) => (
              <button
                key={it.id}
                className="fan-row"
                onClick={() => onOpen(it)}
              >
                <div className="fan-row-thumb">
                  {it.thumb?.b64 ? (
                    <img src={`data:image/png;base64,${it.thumb.b64}`} alt="" draggable={false} />
                  ) : (
                    <span>{it.thumb?.kind === "folder" ? "📁" : "📄"}</span>
                  )}
                </div>
                <span className="fan-row-name">{it.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
