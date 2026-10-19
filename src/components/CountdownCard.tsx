import { useEffect, useRef, useState } from "react";
import Clothespin from "./Clothespin";
import { Spring } from "../spring";
import {
  countdownCardHeight,
  countdownCardWidth,
  REVEAL_BASE,
  ropeY,
  PIN_ABOVE,
  SizeKey,
} from "../layout";
import { formatRemaining } from "./CountdownFields";
import type { Item, Countdown } from "../types";

interface Props {
  item: Item;
  countdown: Countdown;
  width: number;
  size: SizeKey;
  x: number;
  /** 双击：打开编辑弹窗 */
  onEdit: (item: Item) => void;
  onContextMenu: (e: React.MouseEvent, item: Item) => void;
  onRemove: (id: string) => void;
  falling?: boolean;
  reorder?: boolean;
  onPinDown?: (e: React.PointerEvent, item: Item) => void;
}

// 倒计时卡片：与待办卡同款交互（单击无详情，双击编辑；底部实时倒数）。
// 每秒一次 interval 只更新底部倒数字符串，标题 / 内容不随秒跳重渲。
export default function CountdownCard({
  item,
  countdown,
  width,
  size,
  x,
  onEdit,
  onContextMenu,
  onRemove,
  falling,
  reorder,
  onPinDown,
}: Props) {
  const rotRef = useRef<HTMLDivElement>(null);
  const clickTimer = useRef<number>(0);
  const lastClickT = useRef(0);
  const [now, setNow] = useState(() => Date.now());

  // 秒级心跳：同一时刻多张倒计时卡共用各自的 interval（开销可忽略）
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 入场摆动 + 阵风（与普通卡片同一节奏）
  useEffect(() => {
    const el = rotRef.current;
    if (!el) return;
    const tilt = item.tilt;
    const spring = new Spring(
      16,
      (v) => {
        el.style.transform = `rotate(${(tilt + v).toFixed(3)}deg)`;
      },
      46,
      2.6
    );
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
  }, [item.tilt]);

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const nowT = performance.now();
    // 双击：编辑（右键菜单同入口）
    if (nowT - lastClickT.current < 300) {
      lastClickT.current = 0;
      window.clearTimeout(clickTimer.current);
      onEdit(item);
      return;
    }
    lastClickT.current = nowT;
  };

  const cw = countdownCardWidth(size);
  const ch = countdownCardHeight(size);
  const pinY = ropeY(x, width) - PIN_ABOVE;
  const left = countdown.endAt - now;
  const expired = left <= 0;

  return (
    <div
      className={
        "pegged-slot countdown-slot" +
        (falling ? " falling" : "") +
        (reorder ? " reordering" : "")
      }
      data-x={x}
      style={{
        left: x - cw / 2,
        top: pinY,
        ["--card-w" as string]: `${cw}px`,
        ["--todo-h" as string]: `${ch}px`,
        zIndex: reorder ? 300 : 10 + item.index + (falling ? 200 : 0),
      }}
    >
      <div className="pegged-dock">
        <div className="pegged-rot" ref={rotRef}>
          <div
            className="pin-grip"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                /* 指针已失效则退化为 window 监听 */
              }
              onPinDown?.(e, item);
            }}
          >
            <Clothespin />
          </div>
          <div
            className={"card todo-card countdown-card" + (expired ? " expired" : "")}
            onPointerUp={onPointerUp}
            onContextMenu={(e) => onContextMenu(e, item)}
          >
            <div className="todo-text">
              <div className="todo-title">{countdown.title || "（无标题）"}</div>
              <div className="todo-body">{countdown.text || "（无内容）"}</div>
              <div className="countdown-bar">
                <svg
                  viewBox="0 0 1024 1024"
                  width="11"
                  height="11"
                  aria-hidden
                  className="countdown-clock"
                >
                  <path
                    d="M512 74.666667C270.933333 74.666667 74.666667 270.933333 74.666667 512S270.933333 949.333333 512 949.333333 949.333333 753.066667 949.333333 512 753.066667 74.666667 512 74.666667z m0 810.666666c-204.8 0-373.333333-168.533333-373.333333-373.333333S307.2 138.666667 512 138.666667 885.333333 307.2 885.333333 512 716.8 885.333333 512 885.333333z"
                    fill="currentColor"
                  />
                  <path
                    d="M695.466667 567.466667l-151.466667-70.4V277.333333c0-17.066667-14.933333-32-32-32s-32 14.933333-32 32v238.933334c0 12.8 6.4 23.466667 19.2 29.866666l170.666667 81.066667c4.266667 2.133333 8.533333 2.133333 12.8 2.133333 12.8 0 23.466667-6.4 29.866666-19.2 6.4-14.933333 0-34.133333-17.066666-42.666666z"
                    fill="currentColor"
                  />
                </svg>
                <span className="countdown-remaining">
                  {formatRemaining(left)}
                </span>
              </div>
            </div>
            <button
              className="card-x"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRemove(item.id);
              }}
              title="取下卡片"
              aria-label="取下卡片"
            >
              <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden>
                <path
                  d="M1 1 L9 9 M9 1 L1 9"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
