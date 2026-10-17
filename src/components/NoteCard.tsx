import { useEffect, useRef, useState } from "react";
import Clothespin from "./Clothespin";
import { Spring } from "../spring";
import {
  noteCardHeight,
  noteCardWidth,
  REVEAL_BASE,
  ropeY,
  PIN_ABOVE,
  SizeKey,
} from "../layout";
import { api } from "../api";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { isReordering } from "../reorderGuard";
import type { Item } from "../types";

// macOS：tauri-plugin-drag 支持把任意数据（public.utf8-plain-text）拖给别的 App；
// Windows 该能力是空实现，改走 Rust 的 OLE DoDragDrop（CF_UNICODETEXT）。
const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent || "");

// macOS 拖出必须带一张图（插件对空图会直接报 ImageNotFound 而拖不起来），
// 这里把便笺正文画成便签纸当拖影
function dragImage(text: string): string {
  try {
    const c = document.createElement("canvas");
    c.width = 240;
    c.height = 150;
    const g = c.getContext("2d");
    if (!g) return "";
    g.fillStyle = "#ffee9e";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#4a3f12";
    g.font = "14px -apple-system, 'Segoe UI', sans-serif";
    const src = (text || "（空便笺）").split(/\r?\n/);
    const flat: string[] = [];
    for (const line of src) {
      for (let i = 0; i < line.length; i += 14) flat.push(line.slice(i, i + 14));
      if (flat.length > 6) break;
    }
    flat.slice(0, 6).forEach((l, i) => g.fillText(l, 12, 26 + i * 20));
    // 横线（与真实便笺卡一致）：每行文字下方一条，落在半像素上保证清晰
    g.strokeStyle = "rgba(74, 63, 18, 0.18)";
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < Math.min(flat.length, 6); i++) {
      const y = Math.floor(26 + i * 20 + 4.5) + 0.5;
      g.moveTo(10, y);
      g.lineTo(c.width - 10, y);
    }
    g.stroke();
    const url = c.toDataURL("image/png");
    return url.startsWith("data:image/png;base64,") ? url : "";
  } catch {
    return "";
  }
}

interface Props {
  item: Item;
  width: number;
  size: SizeKey;
  x: number;
  /** 双击：打开编辑弹窗 */
  onEdit: (item: Item) => void;
  /** 右键：与其它卡片相同的上下文菜单 */
  onContextMenu: (e: React.MouseEvent, item: Item) => void;
  onRemove: (id: string) => void;
  falling?: boolean;
  reorder?: boolean;
  onPinDown?: (e: React.PointerEvent, item: Item) => void;
}

export default function NoteCard({
  item,
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
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const clickTimer = useRef<number>(0);
  const lastClickT = useRef(0);
  const downPt = useRef<{ x: number; y: number; t: number } | null>(null);
  const dragStarted = useRef(false);

  const cw = noteCardWidth(size);
  const ch = noteCardHeight(size);
  const tilt = item.tilt;
  const text = item.text ?? "";

  // 入场摆动 + 阵风（与普通卡片同一节奏）
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

  const doCopy = async () => {
    try {
      await api.copyText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      console.error(e);
    }
  };

  // 拖出：作为文字拖进输入框，松手即粘贴
  const startTextDrag = () => {
    window.dispatchEvent(new CustomEvent("card-drag-start"));
    const done = () => {
      setDragging(false);
      downPt.current = null;
      window.dispatchEvent(new CustomEvent("card-drag-end"));
    };
    if (IS_MAC) {
      const icon = dragImage(text);
      if (!icon) {
        // 画不出拖影就退化为「复制」，至少内容能带走
        api.copyText(text).finally(done);
        return;
      }
      startDrag({
        item: { data: text, types: ["public.utf8-plain-text"] },
        icon,
      }).finally(done);
    } else {
      api.dragText(text).finally(done);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // 夹子重排会话中：不记拖拽起点（此次按下属于换位操作，不是拖出卡片）
    if (isReordering()) return;
    downPt.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    dragStarted.current = false;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    // 夹子重排会话中：整次拖拽都是沿绳换位。此时左键按住、指针会掠过
    // 其它卡片（也会压在被拖卡片自己身上），若继续走下面的兜底分支，
    // 会把被掠过的卡片误当成「正在拖出」而发起原生拖拽——拖影变成
    // 别人的内容。重排期间一律不触发卡片的文字拖出
    if (isReordering()) return;
    if (!downPt.current && !dragStarted.current && (e.buttons & 1) === 1) {
      downPt.current = { x: e.clientX, y: e.clientY, t: performance.now() };
      dragStarted.current = false;
    }
    const d = downPt.current;
    if (!d || dragStarted.current) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) {
      dragStarted.current = true;
      setDragging(true);
      startTextDrag();
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = downPt.current;
    downPt.current = null;
    if (!d || dragStarted.current) return;
    if (e.button !== 0) return;
    const now = performance.now();
    if (now - d.t > 600) return; // 长按忽略
    // 双击：编辑（右键同效果）
    if (now - lastClickT.current < 300) {
      lastClickT.current = 0;
      window.clearTimeout(clickTimer.current);
      onEdit(item);
      return;
    }
    lastClickT.current = now;
    window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(doCopy, 300);
  };

  const pinY = ropeY(x, width) - PIN_ABOVE;

  return (
    <div
      className={
        "pegged-slot note-slot" +
        (dragging ? " dragging" : "") +
        (falling ? " falling" : "") +
        (reorder ? " reordering" : "")
      }
      data-x={x}
      style={{
        left: x - cw / 2,
        top: pinY,
        ["--card-w" as string]: `${cw}px`,
        ["--note-h" as string]: `${ch}px`,
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
            className="card note-card"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onContextMenu={(e) => onContextMenu(e, item)}
          >
            <div className={"note-text" + (text ? "" : " empty")}>
              {text || "（空便笺）"}
            </div>
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
