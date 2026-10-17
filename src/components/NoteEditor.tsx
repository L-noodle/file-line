import { useEffect, useRef, useState } from "react";
import WindowDialog, { type Rect } from "./WindowDialog";

/**
 * 便笺编辑弹窗：窗口样式，顶部左侧固定标题「便笺」（不可编辑），
 * 右侧打勾按钮确认，中间是正文输入框。
 */
export default function NoteEditor({
  initial,
  onRect,
  onSubmit,
  onClose,
  z,
  onFocus,
}: {
  initial: string;
  onRect: (r: Rect | null) => void;
  onSubmit: (text: string) => void;
  /** 关闭（× / Esc）：带上当前正文，便于调用方判断是否需要丢弃 */
  onClose: (text: string) => void;
  /** 层级（多编辑窗并存时点谁谁在上面） */
  z?: number;
  onFocus?: () => void;
}) {
  const [text, setText] = useState(initial);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.focus();
    // 光标落到末尾（编辑已有便笺时方便续写）
    const n = el.value.length;
    el.setSelectionRange(n, n);
  }, []);

  const submit = () => {
    onSubmit(text);
  };

  return (
    <WindowDialog
      id="note-editor"
      title="便笺"
      width={520}
      onRect={onRect}
      onClose={() => onClose(text)}
      bodyClassName="note-editor-body"
      z={z}
      onFocus={onFocus}
      headRight={
        <button
          className="wdlg-btn wdlg-ok"
          onClick={submit}
          aria-label="保存便笺"
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
      <textarea
        ref={areaRef}
        className="note-input"
        value={text}
        placeholder="写点什么…"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // 输入框内的按键不冒泡到面板（避免误触发窗口级快捷键）
          e.stopPropagation();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
    </WindowDialog>
  );
}
