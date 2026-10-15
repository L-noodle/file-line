import { useEffect, useRef, useState } from "react";
import Clothespin from "./Clothespin";
import CardContent from "./CardContent";
import { Spring } from "../spring";
import { photoMaxHeight, ropeY, ROPE_TOP, PIN_ABOVE, SizeKey, cardWidth, REVEAL_BASE } from "../layout";
import { api } from "../api";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import type { Item } from "../types";

interface Props {
  item: Item;
  width: number;
  size: SizeKey;
  x: number;
  onContextMenu: (e: React.MouseEvent, item: Item) => void;
  onRemove: (id: string) => void;
  falling?: boolean;
  reorder?: boolean;
  onPinDown?: (e: React.PointerEvent, item: Item) => void;
}

export default function PeggedCard({ item, width, size, x, onContextMenu, onRemove, falling, reorder, onPinDown }: Props) {
  const rotRef = useRef<HTMLDivElement>(null);
  const springRef = useRef<Spring | null>(null);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const clickTimer = useRef<number>(0);
  const lastClickT = useRef(0);
  const downPt = useRef<{ x: number; y: number; t: number; path: string } | null>(null);
  const dragStarted = useRef(false);

  const cw = cardWidth(size);
  const ph = photoMaxHeight(size);
  const tilt = item.tilt;

  // 入场摆动：16° → 0（欠阻尼弹簧）
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
    // 阵风：全局自定义事件
    const onGust = (e: Event) => {
      const d = (e as CustomEvent<number>).detail;
      spring.nudge(d * (Math.random() > 0.5 ? 1 : -1));
    };
    window.addEventListener("gust", onGust);
    // 绳子出现：卡片本身始终可见，跟随面板与绳一起滑入落下（同一节奏）。
    // 面板滑入（280ms 缓出）尾段卡片接近到位时，速度脉冲让卡片明显摆动
    // （≈4~6°起摆，欠阻尼晃 2~3 个周期停住），像刚被挂上绳子；
    // 方向 / 幅度随机，每张不同更真实
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

  const doCopy = async () => {
    try {
      await api.copyToClipboard(item.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      console.error(e);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    downPt.current = { x: e.clientX, y: e.clientY, t: performance.now(), path: item.path };
    dragStarted.current = false;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = downPt.current;
    if (!d || dragStarted.current) return;
    const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (dist > 5) {
      dragStarted.current = true;
      setDragging(true);
      window.dispatchEvent(new CustomEvent("card-drag-start"));
      const icon = item.thumb?.icon;
      // 以文件形式拖出（聊天窗口 / 编辑器）
      startDrag({
        item: [item.path],
        icon: icon ?? "",
      }).finally(() => {
        setDragging(false);
        downPt.current = null;
        window.dispatchEvent(new CustomEvent("card-drag-end"));
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = downPt.current;
    downPt.current = null;
    if (!d || dragStarted.current) return;
    if (e.button !== 0) return;
    const now = performance.now();
    if (now - d.t > 600) return; // 长按忽略
    // 双击（PointerEvent.detail 恒为 0，须自行计时）：两次弹起间隔 < 300ms
    if (now - lastClickT.current < 300) {
      lastClickT.current = 0;
      window.clearTimeout(clickTimer.current);
      api.openPath(item.path).catch(console.error);
      return;
    }
    lastClickT.current = now;
    // 单击：延迟触发复制，期间来第二击则取消
    window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(doCopy, 300);
  };

  const pinY = ropeY(x, width) - PIN_ABOVE;

  return (
    <div
      className={
        "pegged-slot" +
        (dragging ? " dragging" : "") +
        (falling ? " falling" : "") +
        (reorder ? " reordering" : "")
      }
      data-x={x}
      style={{
        left: x - cw / 2,
        top: pinY,
        ["--card-w" as string]: `${cw}px`,
        ["--photo-h" as string]: `${ph}px`,
        zIndex: reorder ? 300 : 10 + item.index + (falling ? 200 : 0),
      }}
    >
      {/* Dock 放大层：以挂点（衣夹顶部）为原点，缩放倍数 --dock 由 App 按鼠标距离写入 */}
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
            className="card glass"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onContextMenu={(e) => onContextMenu(e, item)}
          >
            <CardContent item={item} />
            {copied && <div className="copied-tip">已复制</div>}
            <button
              className="card-x"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRemove(item.id);
              }}
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

export { ROPE_TOP };
