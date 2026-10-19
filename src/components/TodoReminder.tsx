import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Todo } from "../types";
import type { Rect } from "./WindowDialog";

// macOS 交互时激活（与面板同样处理：提醒消息可点击 / 可输入）
const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent || "");

const CARD_W = 520;

/**
 * 待办提醒消息：到点后在屏幕顶部弹出，只展示消息本身（不唤出绳子）。
 * App 在提醒期间把窗口临时全屏化（否则条带窗口高度会截断消息本体），
 * 消息初始位于屏幕顶部居中，可按住标题栏拖动。
 * 顶部栏：待办标题 + 右侧关闭按钮
 * 中间：内容（时间说明 + 正文）
 * 底部：稍后 N 分钟再次提醒（N 可改，且不会超过结束时间）
 */
export default function TodoReminder({
  todo,
  kind,
  snoozeMin,
  maxSnooze,
  onSnoozeMin,
  onSnooze,
  onClose,
  onRect,
}: {
  todo: Todo;
  kind: "start" | "end";
  snoozeMin: number;
  maxSnooze: number;
  onSnoozeMin: (n: number) => void;
  onSnooze: () => void;
  onClose: () => void;
  onRect: (r: Rect | null) => void;
}) {
  // 初始：屏幕顶部居中（App 已全屏化窗口，逻辑坐标=屏幕坐标）
  const [pos, setPos] = useState(() => ({
    x: Math.max(8, Math.round((window.innerWidth - Math.min(CARD_W, window.innerWidth - 32)) / 2)),
    y: 40,
  }));
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const movedRef = useRef(false);

  const report = () => {
    const el = document.getElementById("todo-reminder");
    if (!el) return;
    const r = el.getBoundingClientRect();
    onRect({
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  };

  // 挂载 / 位置变化（拖拽）：上报命中区矩形
  useEffect(() => {
    report();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos]);

  // 卸载：撤销命中区
  useEffect(() => {
    return () => onRect(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 全屏化是异步的：挂载时可能仍是条带窗口，resize 后按屏幕宽度重新居中
  useEffect(() => {
    const center = () => {
      if (dragRef.current || movedRef.current) return;
      const card = document.getElementById("todo-reminder");
      const w = card?.offsetWidth ?? Math.min(CARD_W, window.innerWidth - 32);
      setPos({
        x: Math.max(8, Math.round((window.innerWidth - w) / 2)),
        y: 40,
      });
    };
    center();
    const onResize = () => center();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onHeadDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const el = document.getElementById("todo-reminder");
    if (!el) return;
    const r = el.getBoundingClientRect();
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
    movedRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHeadMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = document.getElementById("todo-reminder");
    if (!d || !el) return;
    setPos({
      x: Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, d.ox + e.clientX - d.sx)),
      y: Math.max(4, Math.min(window.innerHeight - el.offsetHeight - 8, d.oy + e.clientY - d.sy)),
    });
  };
  const onHeadUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    report();
  };

  return (
    <div
      className="reminder-wrap"
      style={{ left: pos.x, top: pos.y }}
      onPointerDownCapture={() => {
        if (IS_MAC) api.activateApp().catch(() => { });
      }}
    >
      <div className="card reminder-card glass-strong" id="todo-reminder">
        <div
          className="reminder-head"
          onPointerDown={onHeadDown}
          onPointerMove={onHeadMove}
          onPointerUp={onHeadUp}
          onPointerCancel={onHeadUp}
        >
          <div className="reminder-title">{todo.title || "待办提醒"}
            <div className="reminder-meta">
            {kind === "start" ? "即将开始" : "即将结束"}
            {todo.repeat ? " · 每天重复" : ""}
          </div></div>
          <button
            className="reminder-btn ghost"
            onClick={onClose}
            aria-label="关闭提醒"
            title="关闭"
          >
            关闭 &nbsp;
            <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden>
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
        <div className="reminder-body">

          <div className="reminder-text">{todo.text || "（无内容）"}</div>
        </div>
        <div className="reminder-foot">
          <span className="reminder-lbl">稍后</span>
          <input
            className="reminder-num"
            type="number"
            min={1}
            max={maxSnooze}
            value={snoozeMin}
            onChange={(e) => {
              const n = Number(e.target.value) || 1;
              onSnoozeMin(Math.max(1, Math.min(maxSnooze, n)));
            }}
            onKeyDown={(e) => e.stopPropagation()}
            title={`最多 ${maxSnooze} 分钟（不超过结束时间）`}
          />
          <span className="reminder-lbl">分钟</span>
          <button className="reminder-btn" onClick={onSnooze}>
            再次提醒
          </button>
        </div>
      </div>
    </div>
  );
}
