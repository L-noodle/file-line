import { useState } from "react";
import WindowDialog, { type Rect } from "./WindowDialog";
import TodoFields, { type TodoDraft } from "./TodoFields";

/**
 * 待办编辑弹窗：窗口样式，标题固定「待办」，右侧打勾按钮确认，
 * 内容为待办表单（标题 / 内容 / 开始时间 / 结束时间 / 是否重复 /
 * 开始前提醒 / 结束前提醒）。
 */
export default function TodoEditor({
  initial,
  onRect,
  onSubmit,
  onClose,
  z,
  onFocus,
}: {
  initial: TodoDraft;
  onRect: (r: Rect | null) => void;
  onSubmit: (draft: TodoDraft) => void;
  /** 关闭（× / Esc）：带上当前草稿，便于调用方判断是否需要丢弃 */
  onClose: (draft: TodoDraft) => void;
  z?: number;
  onFocus?: () => void;
}) {
  const [draft, setDraft] = useState(initial);

  const submit = () => onSubmit(draft);

  return (
    <WindowDialog
      id="todo-editor"
      title="待办"
      width={480}
      onRect={onRect}
      onClose={() => onClose(draft)}
      bodyClassName="todo-editor-body"
      z={z}
      onFocus={onFocus}
      headRight={
        <button
          className="wdlg-btn wdlg-ok"
          onClick={submit}
          aria-label="保存待办"
          title="保存（Ctrl/⌘ + Enter）"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path
              d="M2.5 8.6 L6.2 12.3 L13.5 4.4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
        </button>
      }
    >
      <div
        onKeyDown={(e) => {
          // 输入框内的按键不冒泡到面板（避免误触发窗口级快捷键）
          e.stopPropagation();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <TodoFields value={draft} onChange={setDraft} />
      </div>
    </WindowDialog>
  );
}
