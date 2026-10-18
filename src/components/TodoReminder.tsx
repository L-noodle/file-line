import { useEffect } from "react";
import { api } from "../api";
import type { Todo } from "../types";
import type { Rect } from "./WindowDialog";

// macOS 交互时激活（与面板同样处理：提醒消息可点击 / 可输入）
const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent || "");

/**
 * 待办提醒消息：到点后在屏幕顶部弹出，只展示消息本身（不唤出绳子）。
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
  // 命中区上报：窗口未占用时提醒消息必须可点（绳子保持收起）
  useEffect(() => {
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
    report();
    window.addEventListener("resize", report);
    return () => {
      window.removeEventListener("resize", report);
      onRect(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="reminder-wrap"
      onPointerDownCapture={() => {
        if (IS_MAC) api.activateApp().catch(() => { });
      }}
    >
      <div className="card reminder-card glass-strong" id="todo-reminder">
        <div className="reminder-head">
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
