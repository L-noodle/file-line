import { useEffect, useRef, useState } from "react";
import Clothespin from "./Clothespin";
import { Spring } from "../spring";
import {
  todoCardHeight,
  todoCardWidth,
  REVEAL_BASE,
  ropeY,
  PIN_ABOVE,
  SizeKey,
} from "../layout";
import { api } from "../api";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { isReordering } from "../reorderGuard";
import type { Item, Todo } from "../types";

// macOS：tauri-plugin-drag 支持把任意数据（public.utf8-plain-text）拖给别的 App；
// Windows 该能力是空实现，改走 Rust 的 OLE DoDragDrop（CF_UNICODETEXT）。
const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent || "");

// macOS 拖出必须带一张图（插件对空图会直接报 ImageNotFound 而拖不起来），
// 这里把待办（标题 + 内容）画成便签纸当拖影（绿色纸面，与待办卡一致）
function dragImage(title: string, text: string): string {
  try {
    const c = document.createElement("canvas");
    c.width = 240;
    c.height = 150;
    const g = c.getContext("2d");
    if (!g) return "";
    g.fillStyle = "#e6f4dc";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#2f4a1e";
    g.font = "bold 14px -apple-system, 'Segoe UI', sans-serif";
    g.fillText((title || "待办").slice(0, 16), 12, 24);
    g.font = "12px -apple-system, 'Segoe UI', sans-serif";
    const flat: string[] = [];
    for (const line of (text || "").split(/\r?\n/)) {
      for (let i = 0; i < line.length; i += 17) flat.push(line.slice(i, i + 17));
      if (flat.length > 5) break;
    }
    flat.slice(0, 5).forEach((l, i) => g.fillText(l, 12, 48 + i * 18));
    const url = c.toDataURL("image/png");
    return url.startsWith("data:image/png;base64,") ? url : "";
  } catch {
    return "";
  }
}

interface Props {
  item: Item;
  todo: Todo;
  width: number;
  size: SizeKey;
  x: number;
  /** 单击：打开详情弹窗（只展示标题和内容） */
  onOpenDetail: (item: Item) => void;
  /** 双击：打开编辑弹窗（与创建一样可修改） */
  onEdit: (item: Item) => void;
  /** 打勾：完成 / 取消完成（带上卡片 id，完成即把卡片从绳上取下） */
  onToggleDone: (todoId: string, cardId: string) => void;
  /** 右键：与其它卡片相同的上下文菜单 */
  onContextMenu: (e: React.MouseEvent, item: Item) => void;
  onRemove: (id: string) => void;
  falling?: boolean;
  reorder?: boolean;
  onPinDown?: (e: React.PointerEvent, item: Item) => void;
}

export default function TodoCard({
  item,
  todo,
  width,
  size,
  x,
  onOpenDetail,
  onEdit,
  onToggleDone,
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

  const cw = todoCardWidth(size);
  const ch = todoCardHeight(size);
  const tilt = item.tilt;
  const title = todo.title;
  const text = todo.text;

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
      await api.copyText(`${title}\n${text}`.trim());
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
      const icon = dragImage(title, text);
      if (!icon) {
        // 画不出拖影就退化为「复制」，至少内容能带走
        api.copyText(`${title}\n${text}`.trim()).finally(done);
        return;
      }
      startDrag({
        item: { data: `${title}\n${text}`.trim(), types: ["public.utf8-plain-text"] },
        icon,
      }).finally(done);
    } else {
      api.dragText(`${title}\n${text}`.trim()).finally(done);
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
    // 夹子重排会话中：整次拖拽都是沿绳换位，不触发卡片的文字拖出
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
    // 单击：打开详情弹窗（只展示标题和内容）
    clickTimer.current = window.setTimeout(() => onOpenDetail(item), 300);
  };

  const pinY = ropeY(x, width) - PIN_ABOVE;

  return (
    <div
      className={
        "pegged-slot todo-slot" +
        (dragging ? " dragging" : "") +
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
            className={"card todo-card" + (todo.done ? " done" : "")}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onContextMenu={(e) => onContextMenu(e, item)}
          >
            <div className="todo-text">
              <div className="todo-title">{title || "（无标题）"}</div>
              <div className="todo-body">{text || "（无内容）"}</div>
            </div>
            {copied && <div className="copied-tip">已复制</div>}
            {/* 悬浮：打勾（完成）在取消按钮旁边，绿色 icon */}
            <button
              className="card-check"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggleDone(todo.id, item.id);
              }}
              title={todo.done ? "取消完成" : "完成待办"}
              aria-label={todo.done ? "取消完成" : "完成待办"}
            >
              <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden>
                <path
                  d="M2.5 8.6 L6.2 12.3 L13.5 4.4"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
            </button>
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
