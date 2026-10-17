import { useEffect, useRef, useState } from "react";
import WindowDialog, { type Rect } from "./WindowDialog";
import type { Note } from "../types";

function stamp(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 列表预览：取首个非空行，最多 24 字 */
function preview(note: Note): string {
  const line = (note.text || "").split(/\r?\n/).find((l) => l.trim().length > 0);
  const s = (line ?? "").trim();
  if (!s) return "（空便笺）";
  return s.length > 24 ? s.slice(0, 24) + "…" : s;
}

// ---------- 图标（1024 网格，fill 走 currentColor 以便跟随文字色） ----------
const P = { fill: "currentColor" } as const;

/** 置顶（图钉） */
function IconPin() {
  return (
    <svg viewBox="0 0 1024 1024" width="15" height="15" aria-hidden>
      <path
        d="M911.15102 323.918367L689.632653 102.4c-18.808163-18.808163-50.155102-20.897959-71.053061-2.089796l-267.493878 229.877551-96.130612 14.628572c-6.269388 0-12.538776 4.179592-16.718367 8.359183l-58.514286 58.514286c-20.897959 20.897959-20.897959 54.334694 0 73.142857l152.555102 152.555102L125.387755 844.277551c-12.538776 12.538776-12.538776 31.346939 0 43.885714 6.269388 6.269388 14.628571 10.44898 20.897959 10.44898s16.718367-2.089796 22.987755-8.359184l204.8-204.8 152.555102 152.555102c10.44898 10.44898 22.987755 14.628571 37.616327 14.628572s27.167347-6.269388 37.616326-14.628572l58.514286-58.514285c4.179592-4.179592 8.359184-10.44898 8.359184-16.718368l14.628571-96.130612 227.787755-267.493878c18.808163-25.077551 18.808163-56.42449 0-75.232653zM631.118367 629.028571c-4.179592 4.179592-6.269388 10.44898-6.269387 14.628572l-14.628572 94.040816-45.97551 45.97551-334.367347-334.367347 43.885714-43.885714 94.040817-14.628571c6.269388 0 10.44898-4.179592 14.628571-6.269388l269.583674-229.877551 206.889795 206.889796-227.787755 267.493877z"
        {...P}
      />
    </svg>
  );
}

/** 挂起（挂到绳子上） */
function IconHang() {
  return (
    <svg viewBox="0 0 1024 1024" width="15" height="15" aria-hidden>
      <path
        d="M823.466667 512H578.133333v-187.733333c0-66.133333-53.333333-119.466667-117.333333-119.466667s-117.333333 53.333333-117.333333 119.466667v296.533333l-21.333334-21.333333c-46.933333-46.933333-121.6-46.933333-168.533333-2.133334s-44.8 121.6 2.133333 168.533334l174.933334 174.933333c6.4 6.4 14.933333 8.533333 23.466666 8.533333 8.533333 0 17.066667-2.133333 23.466667-8.533333 12.8-12.8 12.8-32 0-44.8l-174.933333-174.933333c-21.333333-21.333333-23.466667-57.6-2.133334-76.8 21.333333-21.333333 55.466667-19.2 76.8 2.133333l74.666667 74.666667c12.8 12.8 32 12.8 44.8 0 6.4-6.4 8.533333-14.933333 8.533333-23.466667V326.4c0-29.866667 23.466667-55.466667 53.333334-55.466667s53.333333 25.6 53.333333 55.466667v219.733333c0 17.066667 14.933333 32 32 32h277.333333c6.4 0 10.666667 6.4 10.666667 12.8V917.333333c0 17.066667 14.933333 32 32 32S896 934.4 896 917.333333V586.666667c2.133333-40.533333-32-74.666667-72.533333-74.666667z"
        {...P}
      />
      <path
        d="M266.666667 330.666667c17.066667 0 32-14.933333 32-32 0-87.466667 72.533333-160 160-160S618.666667 211.2 618.666667 298.666667c0 17.066667 14.933333 32 32 32S682.666667 315.733333 682.666667 298.666667c0-123.733333-100.266667-224-224-224S234.666667 174.933333 234.666667 298.666667c0 17.066667 14.933333 32 32 32z"
        {...P}
      />
    </svg>
  );
}

/** 删除 */
function IconTrash() {
  return (
    <svg viewBox="0 0 1024 1024" width="15" height="15" aria-hidden>
      <path
        d="M874.666667 241.066667h-202.666667V170.666667c0-40.533333-34.133333-74.666667-74.666667-74.666667h-170.666666c-40.533333 0-74.666667 34.133333-74.666667 74.666667v70.4H149.333333c-17.066667 0-32 14.933333-32 32s14.933333 32 32 32h53.333334V853.333333c0 40.533333 34.133333 74.666667 74.666666 74.666667h469.333334c40.533333 0 74.666667-34.133333 74.666666-74.666667V305.066667H874.666667c17.066667 0 32-14.933333 32-32s-14.933333-32-32-32zM416 170.666667c0-6.4 4.266667-10.666667 10.666667-10.666667h170.666666c6.4 0 10.666667 4.266667 10.666667 10.666667v70.4h-192V170.666667z m341.333333 682.666666c0 6.4-4.266667 10.666667-10.666666 10.666667H277.333333c-6.4 0-10.666667-4.266667-10.666666-10.666667V309.333333h490.666666V853.333333z"
        {...P}
      />
      <path
        d="M426.666667 736c17.066667 0 32-14.933333 32-32V490.666667c0-17.066667-14.933333-32-32-32s-32 14.933333-32 32v213.333333c0 17.066667 14.933333 32 32 32zM597.333333 736c17.066667 0 32-14.933333 32-32V490.666667c0-17.066667-14.933333-32-32-32s-32 14.933333-32 32v213.333333c0 17.066667 14.933333 32 32 32z"
        {...P}
      />
    </svg>
  );
}

/** 拖拽排序把手 */
function IconDrag() {
  return (
    <svg viewBox="0 0 1024 1024" width="13" height="13" aria-hidden>
      <path d="M362.666667 192m-64 0a64 64 0 1 0 128 0 64 64 0 1 0-128 0Z" {...P} />
      <path d="M661.333333 192m-64 0a64 64 0 1 0 128 0 64 64 0 1 0-128 0Z" {...P} />
      <path d="M362.666667 512m-64 0a64 64 0 1 0 128 0 64 64 0 1 0-128 0Z" {...P} />
      <path d="M661.333333 512m-64 0a64 64 0 1 0 128 0 64 64 0 1 0-128 0Z" {...P} />
      <path d="M362.666667 832m-64 0a64 64 0 1 0 128 0 64 64 0 1 0-128 0Z" {...P} />
      <path d="M661.333333 832m-64 0a64 64 0 1 0 128 0 64 64 0 1 0-128 0Z" {...P} />
    </svg>
  );
}

/** 新增便笺 */
function IconNew() {
  return (
    <svg viewBox="0 0 1024 1024" width="14" height="14" aria-hidden>
      <path
        d="M853.333333 501.333333c-17.066667 0-32 14.933333-32 32v320c0 6.4-4.266667 10.666667-10.666666 10.666667H170.666667c-6.4 0-10.666667-4.266667-10.666667-10.666667V213.333333c0-6.4 4.266667-10.666667 10.666667-10.666666h320c17.066667 0 32-14.933333 32-32s-14.933333-32-32-32H170.666667c-40.533333 0-74.666667 34.133333-74.666667 74.666666v640c0 40.533333 34.133333 74.666667 74.666667 74.666667h640c40.533333 0 74.666667-34.133333 74.666666-74.666667V533.333333c0-17.066667-14.933333-32-32-32z"
        {...P}
      />
      <path
        d="M405.333333 484.266667l-32 125.866666c-2.133333 10.666667 0 23.466667 8.533334 29.866667 6.4 6.4 14.933333 8.533333 23.466666 8.533333h8.533334l125.866666-32c6.4-2.133333 10.666667-4.266667 14.933334-8.533333l300.8-300.8c38.4-38.4 38.4-102.4 0-140.8-38.4-38.4-102.4-38.4-140.8 0L413.866667 469.333333c-4.266667 4.266667-6.4 8.533333-8.533334 14.933334z m59.733334 23.466666L761.6 213.333333c12.8-12.8 36.266667-12.8 49.066667 0 12.8 12.8 12.8 36.266667 0 49.066667L516.266667 558.933333l-66.133334 17.066667 14.933334-68.266667z"
        {...P}
      />
    </svg>
  );
}

/**
 * 笔记本（便笺管理器）：左右布局。左侧便笺列表（顺序可拖拽调整 / 可滚动 /
 * 默认不选中），每行左侧拖拽把手、右侧置顶 / 挂起 / 删除；右侧正文可直接编辑。
 */
export default function Notebook({
  notes,
  onRect,
  onCreate,
  onHang,
  onTogglePin,
  onReorder,
  onDelete,
  onEdit,
  onEditEnd,
  z,
  onFocus,
  onClose,
}: {
  notes: Note[];
  onRect: (r: Rect | null) => void;
  /** 新增便笺，返回新便笺 id（用于立即选中） */
  onCreate: () => string;
  onHang: (noteId: string) => void;
  onTogglePin: (noteId: string) => void;
  /** 拖拽排序：把该便笺插到展示顺序的第 index 位 */
  onReorder: (noteId: string, index: number) => void;
  onDelete: (noteId: string) => void;
  /** 右侧直接编辑：实时写回 */
  onEdit: (noteId: string, text: string) => void;
  /** 右侧编辑结束（失焦）：刷新时间 */
  onEditEnd: (noteId: string) => void;
  z?: number;
  onFocus?: () => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  // 右侧编辑草稿：null = 直接显示便笺原文
  const [draft, setDraft] = useState<string | null>(null);
  // 拖拽排序
  const listRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  // 展示顺序：置顶的一组在最前，其余保持（可拖拽调整的）列表顺序
  const ordered = [...notes].sort((a, b) =>
    !!a.pinned !== !!b.pinned ? (a.pinned ? -1 : 1) : 0
  );
  const current = ordered.find((n) => n.id === selected) ?? null;

  // 切换选中项：丢弃上一份草稿
  useEffect(() => {
    setDraft(null);
  }, [selected]);

  const value = draft ?? current?.text ?? "";

  const onHandleDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 指针不可捕获则退化 */
    }
    dragRef.current = { id };
    setDragId(id);
  };

  const onHandleMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const list = listRef.current;
    if (!list) return;
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const row = el?.closest(".nb-row") as HTMLElement | null;
    if (!row) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>(".nb-row"));
    const i = rows.indexOf(row);
    if (i < 0) return;
    const r = row.getBoundingClientRect();
    setDropAt(e.clientY > r.top + r.height / 2 ? i + 1 : i);
  };

  const onHandleUp = () => {
    const d = dragRef.current;
    const at = dropAt;
    dragRef.current = null;
    setDragId(null);
    setDropAt(null);
    if (d && at != null) onReorder(d.id, at);
  };

  return (
    <WindowDialog
      id="notebook-dialog"
      title="笔记本"
      width={660}
      onRect={onRect}
      onClose={onClose}
      closeOnOutside
      bodyClassName="nb-body"
      z={z}
      onFocus={onFocus}
      headRight={
        <button
          className="wdlg-btn wdlg-wide"
          onClick={() => setSelected(onCreate())}
          title="新增便笺"
        >
          <IconNew />
          新增
        </button>
      }
    >
      <div className="nb-inner">
        <div
          className={"nb-list" + (dragId ? " sorting" : "")}
          ref={listRef}
        >
          {ordered.length === 0 && <div className="nb-empty">还没有便笺</div>}
          {ordered.map((n, i) => (
            <div
              key={n.id}
              data-id={n.id}
              className={
                "nb-row" +
                (n.id === selected ? " on" : "") +
                (n.id === dragId ? " dragging" : "") +
                (dropAt === i ? " drop-top" : "") +
                (dropAt === i + 1 && i === ordered.length - 1 ? " drop-bottom" : "")
              }
              onClick={() => setSelected(n.id)}
            >
              <span
                className="nb-grip"
                title="拖动调整顺序"
                onPointerDown={(e) => onHandleDown(e, n.id)}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
                onClick={(e) => e.stopPropagation()}
              >
                <IconDrag />
              </span>
              <div className="nb-row-main">
                <div className="nb-row-text">
                  {n.pinned && <span className="nb-pin-mark">置顶</span>}
                  {preview(n)}
                </div>
                <div className="nb-row-time">{stamp(n.updatedAt)}</div>
              </div>
              <div className="nb-row-ops">
                <button
                  className={"nb-op icon" + (n.pinned ? " active" : "")}
                  title={n.pinned ? "取消置顶" : "置顶"}
                  aria-label={n.pinned ? "取消置顶" : "置顶"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePin(n.id);
                  }}
                >
                  <IconPin />
                </button>
                <button
                  className="nb-op icon"
                  title="挂起"
                  aria-label="挂起"
                  onClick={(e) => {
                    e.stopPropagation();
                    onHang(n.id);
                  }}
                >
                  <IconHang />
                </button>
                <button
                  className="nb-op icon danger"
                  title="删除"
                  aria-label="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(n.id);
                  }}
                >
                  <IconTrash />
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="nb-content">
          {current ? (
            <textarea
              className="nb-text nb-edit"
              value={value}
              placeholder="写点什么…"
              spellCheck={false}
              onChange={(e) => {
                setDraft(e.target.value);
                onEdit(current.id, e.target.value);
              }}
              onBlur={() => onEditEnd(current.id)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          ) : (
            <div className="nb-placeholder">
              <div className="nb-ph-text">
                请选择便笺，若无便笺点击顶部新增按钮创建
              </div>
            </div>
          )}
        </div>
      </div>
    </WindowDialog>
  );
}
