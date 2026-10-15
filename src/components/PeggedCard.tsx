import { useEffect, useRef, useState } from "react";
import Clothespin from "./Clothespin";
import CardContent from "./CardContent";
import { Spring } from "../spring";
import { photoMaxHeight, ropeY, ROPE_TOP, PIN_ABOVE, SizeKey, cardWidth, REVEAL_BASE, REVEAL_DUR, revealStagger } from "../layout";
import { api } from "../api";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import type { Item } from "../types";

interface Props {
  item: Item;
  index: number;
  count: number;
  width: number;
  size: SizeKey;
  x: number;
  onContextMenu: (e: React.MouseEvent, item: Item) => void;
  onRemove: (id: string) => void;
  falling?: boolean;
}

export default function PeggedCard({ item, index, count, width, size, x, onContextMenu, onRemove, falling }: Props) {
  // 滚动平移时 index/count 会变，但入场效果只应发生一次——
  // 用 ref 读最新值，effect 不因 index 重跑（否则滚动时全绳重新摆动）
  const indexRef = useRef(index);
  const countRef = useRef(count);
  indexRef.current = index;
  countRef.current = count;
  const rotRef = useRef<HTMLDivElement>(null);
  const enterRef = useRef<HTMLDivElement>(null);
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
    // 绳子出现：从左到右波浪式浮现，每张挂上后明显晃动几下
    let revealTimer = 0;
    const onReveal = () => {
      // 等面板滑入（280ms 缓出）尾段再开始，否则 stagger 会被整体滑入掩盖
      // 错峰用 revealStagger：左侧卡片出现快，往右逐渐放缓（由快转慢）
      const delay = REVEAL_BASE + revealStagger(indexRef.current, countRef.current);
      enterRef.current?.animate(
        [
          { opacity: 0, transform: "translateY(-14px) scale(0.96)" },
          { opacity: 1, transform: "translateY(0) scale(1)" },
        ],
        {
          duration: REVEAL_DUR,
          delay,
          easing: "cubic-bezier(0.2, 0.9, 0.3, 1.1)",
          fill: "backwards", // delay 期间保持初始帧（隐藏）
        },
      );
      // 浮现尾段：速度脉冲让卡片明显摆动（≈4~6°起摆，欠阻尼晃 2~3 个周期停住），
      // 像刚被挂上绳子的晃动；方向 / 幅度随机，每张不同更真实
      revealTimer = window.setTimeout(() => {
        spring.nudge((28 + Math.random() * 14) * (Math.random() > 0.5 ? 1 : -1));
      }, delay + 200);
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
      className={"pegged-slot" + (dragging ? " dragging" : "") + (falling ? " falling" : "")}
      style={{
        left: x - cw / 2,
        top: pinY,
        ["--card-w" as string]: `${cw}px`,
        ["--photo-h" as string]: `${ph}px`,
        zIndex: 10 + item.index + (falling ? 200 : 0),
      }}
    >
      {/* 入场层：reveal 时 Web Animations 播放陆续浮现（独立于 slot 的 dropIn/falling 与 rot 的弹簧） */}
      <div className="pegged-enter" ref={enterRef}>
        <div className="pegged-rot" ref={rotRef}>
        <Clothespin />
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
