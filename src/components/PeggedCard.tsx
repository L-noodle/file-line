import { useEffect, useRef, useState } from "react";
import Clothespin from "./Clothespin";
import { Spring } from "../spring";
import { photoMaxHeight, ropeY, ROPE_TOP, PIN_ABOVE, SizeKey, cardWidth } from "../layout";
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

export default function PeggedCard({ item, index, width, size, x, onContextMenu, onRemove, falling }: Props) {
  const rotRef = useRef<HTMLDivElement>(null);
  const springRef = useRef<Spring | null>(null);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const clickTimer = useRef<number>(0);
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
    // 绳子出现：轻风带动晃动，卡片从左到右波浪式延迟
    let revealTimer = 0;
    const onReveal = () => {
      revealTimer = window.setTimeout(
        () => {
          spring.nudge((0.8 + Math.random() * 0.9) * (Math.random() > 0.5 ? 1 : -1));
        },
        index * 45 + Math.random() * 50
      );
    };
    window.addEventListener("rope-reveal", onReveal);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(revealTimer);
      window.removeEventListener("gust", onGust);
      window.removeEventListener("rope-reveal", onReveal);
      spring.destroy();
    };
  }, [tilt, index]);

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
    if (e.detail === 2) {
      // 双击：默认程序打开
      window.clearTimeout(clickTimer.current);
      api.openPath(item.path).catch(console.error);
      return;
    }
    // 单击：延迟触发复制，期间来第二击则取消
    window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(doCopy, 260);
  };

  const pinY = ropeY(x, width) - PIN_ABOVE;
  const content = () => {
    if (item.thumb?.kind === "image" && item.thumb.b64) {
      return (
        <img
          className="card-img"
          src={`data:image/png;base64,${item.thumb.b64}`}
          alt={item.name}
          draggable={false}
        />
      );
    }
    if (item.thumb?.kind === "folder") {
      return (
        <div className="card-tile folder">
          {item.thumb.b64 ? (
            <img
              className="folder-img"
              src={`data:image/png;base64,${item.thumb.b64}`}
              alt={item.name}
              draggable={false}
            />
          ) : (
            <svg viewBox="0 0 48 40" className="folder-icon" aria-hidden>
              <path d="M2 8a4 4 0 0 1 4-4h10l5 5h21a4 4 0 0 1 4 4v21a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z" />
              <path d="M2 13h44v4H2z" fill="rgba(0,0,0,0.08)" />
            </svg>
          )}
          <div className="card-name">{item.name}</div>
        </div>
      );
    }
    if (item.thumb?.b64) {
      return (
        <div className="card-tile file">
          <img
            className="file-img"
            src={`data:image/png;base64,${item.thumb.b64}`}
            alt={item.name}
            draggable={false}
          />
          <div className="card-name">{item.name}</div>
        </div>
      );
    }
    const ext = item.name.includes(".")
      ? item.name.split(".").pop()!.toUpperCase().slice(0, 4)
      : "FILE";
    return (
      <div className="card-tile file">
        <svg viewBox="0 0 36 44" className="file-icon" aria-hidden>
          <path d="M4 4a3 3 0 0 1 3-3h14l11 11v28a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V4z" />
          <path d="M21 1l11 11H21V1z" fill="rgba(255,255,255,0.45)" />
        </svg>
        <div className="file-ext">{ext}</div>
        <div className="card-name">{item.name}</div>
      </div>
    );
  };

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
      <div className="pegged-rot" ref={rotRef}>
        <Clothespin />
        <div
          className="card glass"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onContextMenu={(e) => onContextMenu(e, item)}
        >
          {content()}
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
  );
}

export { ROPE_TOP };
