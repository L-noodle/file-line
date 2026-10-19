import { useState } from "react";
import WindowDialog, { type Rect } from "./WindowDialog";
import CountdownFields, { type CountdownDraft } from "./CountdownFields";

/**
 * 倒计时编辑弹窗：窗口样式，标题固定「倒计时」，右侧打勾按钮确认，
 * 内容为倒计时表单（名称 / 内容 / 截止日期）。
 */
export default function CountdownEditor({
  initial,
  onRect,
  onSubmit,
  onClose,
  z,
  onFocus,
}: {
  initial: CountdownDraft;
  onRect: (r: Rect | null) => void;
  onSubmit: (draft: CountdownDraft) => void;
  /** 关闭（× / Esc）：带上当前草稿，便于调用方判断是否需要丢弃 */
  onClose: (draft: CountdownDraft) => void;
  z?: number;
  onFocus?: () => void;
}) {
  const [draft, setDraft] = useState(initial);

  const submit = () => onSubmit(draft);

  return (
    <WindowDialog
      id="countdown-editor"
      title="倒计时"
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
          aria-label="保存倒计时"
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
        <CountdownFields value={draft} onChange={setDraft} />
      </div>
    </WindowDialog>
  );
}
