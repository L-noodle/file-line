import WindowDialog, { type Rect } from "./WindowDialog";
import type { Todo } from "../types";

/**
 * 待办详情弹窗（单击待办卡片打开）：只展示标题和内容。
 * 右上角提供「编辑」入口，效果等同双击卡片。
 */
export default function TodoDetail({
  todo,
  onRect,
  onEdit,
  z,
  onFocus,
  onClose,
}: {
  todo: Todo;
  onRect: (r: Rect | null) => void;
  onEdit: () => void;
  z?: number;
  onFocus?: () => void;
  onClose: () => void;
}) {
  return (
    <WindowDialog
      id="todo-detail"
      title="待办详情"
      width={440}
      onRect={onRect}
      onClose={onClose}
      bodyClassName="todo-detail-body"
      z={z}
      onFocus={onFocus}
      headRight={
        <button
          className="wdlg-btn wdlg-wide"
          onClick={onEdit}
          aria-label="编辑待办"
          title="编辑（双击卡片同效果）"
        >
          <svg viewBox="0 0 1024 1024" width="13" height="13" aria-hidden>
            <path
              d="M853.333333 501.333333c-17.066667 0-32 14.933333-32 32v320c0 6.4-4.266667 10.666667-10.666666 10.666667H170.666667c-6.4 0-10.666667-4.266667-10.666667-10.666667V213.333333c0-6.4 4.266667-10.666667 10.666667-10.666666h320c17.066667 0 32-14.933333 32-32s-14.933333-32-32-32H170.666667c-40.533333 0-74.666667 34.133333-74.666667 74.666666v640c0 40.533333 34.133333 74.666667 74.666667 74.666667h640c40.533333 0 74.666667-34.133333 74.666666-74.666667V533.333333c0-17.066667-14.933333-32-32-32z"
              fill="currentColor"
            />
            <path
              d="M405.333333 484.266667l-32 125.866666c-2.133333 10.666667 0 23.466667 8.533334 29.866667 6.4 6.4 14.933333 8.533333 23.466666 8.533333h8.533334l125.866666-32c6.4-2.133333 10.666667-4.266667 14.933334-8.533333l300.8-300.8c38.4-38.4 38.4-102.4 0-140.8-38.4-38.4-102.4-38.4-140.8 0L413.866667 469.333333c-4.266667 4.266667-6.4 8.533333-8.533334 14.933334z m59.733334 23.466666L761.6 213.333333c12.8-12.8 36.266667-12.8 49.066667 0 12.8 12.8 12.8 36.266667 0 49.066667L516.266667 558.933333l-66.133334 17.066667 14.933334-68.266667z"
              fill="currentColor"
            />
          </svg>
          编辑
        </button>
      }
    >
      <div className="todo-detail-title">{todo.title || "（无标题）"}</div>
      <div className="todo-detail-text">{todo.text || "（无内容）"}</div>
    </WindowDialog>
  );
}
