import { useEffect, useRef, useState } from "react";
import WindowDialog, { type Rect } from "./WindowDialog";
import type { Note, Todo } from "../types";
import TodoFields, { todoDraftOf } from "./TodoFields";

function stamp(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 待办行的时间展示：有开始时间则显示时间段，否则显示修改时间 */
function todoStamp(t: Todo): string {
  if (t.startAt) {
    const s = stamp(t.startAt);
    return t.endAt ? `${s} ~ ${stamp(t.endAt).slice(6)}` : s;
  }
  return stamp(t.updatedAt);
}

/** 列表预览：取首个非空行，最多 24 字 */
function preview(text: string): string {
  const line = (text || "").split(/\r?\n/).find((l) => l.trim().length > 0);
  const s = (line ?? "").trim();
  if (!s) return "（无内容）";
  return s.length > 24 ? s.slice(0, 24) + "…" : s;
}

// 创建时间（老数据没有 createdAt，回落到 updatedAt）
const createdOf = (n: Note | Todo): number => n.createdAt ?? n.updatedAt ?? 0;

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
        d="M874.666667 241.066667h-202.666667V170.666667c0-40.533333-34.133333-74.666667-74.666667-74.666667h-170.666666c-40.533333 0-74.666667 34.133333-74.666667 74.666667v70.4H149.333333c-17.066667 0-32 14.933333-32 32s14.933333 32 32 32h53.333334V853.333333c0 40.533333 34.133333 74.666667 74.666666 74.666667h469.333334c40.533333 0 74.666667-34.133333 74.666666-74.666667V305.066667H874.666667c17.066667 0 32-14.933333 32-32s-14.933333-32-32-32zM416 170.666667c0-6.4 4.266667-10.666667 10.666667-10.666667h170.666666c6.4 0 10.666667-4.266667 10.666667 10.666667v70.4h-192V170.666667z m341.333333 682.666666c0 6.4-4.266667 10.666667-10.666666 10.666667H277.333333c-6.4 0-10.666667-4.266667-10.666666-10.666667V309.333333h490.666666V853.333333z"
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

/** 新增待办（方框 + 对勾，fill 走 currentColor 以便跟随文字色） */
function IconTodoNew() {
  return (
    <svg viewBox="0 0 1024 1024" width="14" height="14" aria-hidden>
      <path
        d="M874.666667 501.333333c-17.066667 0-32 14.933333-32 32v298.666667c0 6.4-4.266667 10.666667-10.666667 10.666667H192c-6.4 0-10.666667-4.266667-10.666667-10.666667V192c0-6.4 4.266667-10.666667 10.666667-10.666667h469.333333c17.066667 0 32-14.933333 32-32s-14.933333-32-32-32H192C151.466667 117.333333 117.333333 151.466667 117.333333 192v640c0 40.533333 34.133333 74.666667 74.666667 74.666667h640c40.533333 0 74.666667-34.133333 74.666667-74.666667V533.333333c0-17.066667-14.933333-32-32-32z"
        {...P}
      />
      <path
        d="M940.8 168.533333c-12.8-12.8-32-12.8-44.8 0l-390.4 384-106.666667-106.666666c-12.8-12.8-32-12.8-44.8 0-12.8 12.8-12.8 32 0 44.8l130.133334 128c6.4 6.4 14.933333 8.533333 23.466666 8.533333s17.066667-2.133333 23.466667-8.533333l411.733333-405.333334c8.533333-10.666667 10.666667-32-2.133333-44.8z"
        {...P}
      />
    </svg>
  );
}

/** 完成（打勾） */
function IconCheck() {
  return (
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
  );
}

type TabKey = "all" | "note" | "todo";

const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "note", label: "便笺" },
  { key: "todo", label: "待办" },
];

/** 列表行：便笺 / 待办混排 */
type Row =
  | { kind: "note"; note: Note }
  | { kind: "todo"; todo: Todo };

/**
 * 笔记本（便笺 / 待办管理器）：左右布局。
 * 左侧列表顶部三个 Tab（全部 / 便笺 / 待办），右侧为选中项的完整编辑内容。
 * - 全部：便笺与未完成待办按创建时间穿插展示（不展示已完成的待办）
 * - 待办：完成的待办排在最后，已完成的不支持拖拽 / 挂载 / 置顶
 * - 待办行左侧有勾选框，可完成 / 取消完成；完成后置灰 + 删除线并取消置顶
 */
export default function Notebook({
  notes,
  todos,
  onRect,
  onCreate,
  onCreateTodo,
  onHang,
  onTogglePin,
  onReorder,
  onDelete,
  onEdit,
  onEditEnd,
  onHangTodo,
  onTogglePinTodo,
  onToggleDone,
  onReorderTodo,
  onDeleteTodo,
  onEditTodo,
  z,
  onFocus,
  onClose,
}: {
  notes: Note[];
  todos: Todo[];
  onRect: (r: Rect | null) => void;
  /** 新增便笺，返回新便笺 id（用于立即选中） */
  onCreate: () => string;
  /** 新增待办，返回新待办 id（用于立即选中） */
  onCreateTodo: () => string;
  onHang: (noteId: string) => void;
  onTogglePin: (noteId: string) => void;
  /** 拖拽排序：把该便笺插到展示顺序的第 index 位 */
  onReorder: (noteId: string, index: number) => void;
  onDelete: (noteId: string) => void;
  /** 右侧直接编辑：实时写回 */
  onEdit: (noteId: string, text: string) => void;
  /** 右侧编辑结束（失焦）：刷新时间 */
  onEditEnd: (noteId: string) => void;
  onHangTodo: (todoId: string) => void;
  onTogglePinTodo: (todoId: string) => void;
  /** 完成 / 取消完成待办 */
  onToggleDone: (todoId: string) => void;
  onReorderTodo: (todoId: string, index: number) => void;
  onDeleteTodo: (todoId: string) => void;
  /** 右侧直接编辑待办：实时写回 */
  onEditTodo: (todoId: string, draft: ReturnType<typeof todoDraftOf>) => void;
  z?: number;
  onFocus?: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<TabKey>("all");
  const [selected, setSelected] = useState<{ kind: "note" | "todo"; id: string } | null>(
    null
  );
  // 右侧编辑草稿：null = 直接显示便笺原文
  const [draft, setDraft] = useState<string | null>(null);
  // 拖拽排序
  const listRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  // 便笺：置顶的一组在最前，其余保持（可拖拽调整的）列表顺序
  const orderedNotes = [...notes].sort((a, b) =>
    !!a.pinned !== !!b.pinned ? (a.pinned ? -1 : 1) : 0
  );
  // 待办：置顶且未完成 → 未完成 → 已完成，各组内保持列表顺序
  const orderedTodos = [...todos].sort((a, b) => {
    const g = (t: Todo) => (t.done ? 2 : t.pinned ? 0 : 1);
    return g(a) - g(b);
  });

  // 当前 Tab 的行
  // - 便笺：置顶组在前，其余保持列表顺序（与原行为一致）
  // - 待办：置顶且未完成 → 未完成 → 已完成（orderedTodos 已排好）
  // - 全部：便笺与未完成待办按创建时间穿插（置顶组在前，新的在前）
  const rows: Row[] =
    tab === "note"
      ? orderedNotes.map((note) => ({ kind: "note", note }) as Row)
      : tab === "todo"
        ? orderedTodos.map((todo) => ({ kind: "todo", todo }) as Row)
        : (() => {
            const mixed: Row[] = [
              ...orderedNotes.map((note) => ({ kind: "note", note }) as Row),
              ...orderedTodos
                .filter((t) => !t.done)
                .map((todo) => ({ kind: "todo", todo }) as Row),
            ];
            const byCreatedDesc = (a: Row, b: Row) =>
              createdOf(b.kind === "note" ? b.note : b.todo) -
              createdOf(a.kind === "note" ? a.note : a.todo);
            return [
              ...mixed
                .filter((r) => (r.kind === "note" ? r.note.pinned : r.todo.pinned))
                .sort(byCreatedDesc),
              ...mixed
                .filter((r) => !(r.kind === "note" ? r.note.pinned : r.todo.pinned))
                .sort(byCreatedDesc),
            ];
          })();

  const current =
    rows.find(
      (r) =>
        r.kind === selected?.kind &&
        (r.kind === "note" ? r.note.id === selected.id : r.todo.id === selected.id)
    ) ?? null;

  // 切换 Tab：丢弃草稿与选中（选中项可能不在新 Tab 里）
  useEffect(() => {
    setDraft(null);
    setSelected(null);
  }, [tab]);

  // 切换选中项：丢弃上一份草稿
  useEffect(() => {
    setDraft(null);
  }, [selected]);

  const value = draft ?? (current?.kind === "note" ? current.note.text : "");

  // 是否可拖拽排序：全部 Tab 不排序（跨类型混排）；已完成待办不可排序
  const reorderable = (r: Row) =>
    tab !== "all" && (r.kind === "note" || !r.todo.done);

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
    const rowsEls = Array.from(list.querySelectorAll<HTMLElement>(".nb-row"));
    const i = rowsEls.indexOf(row);
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
    if (!d || at == null) return;
    if (tab === "todo") onReorderTodo(d.id, at);
    else onReorder(d.id, at);
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
        <>
          {/* 便笺按钮：与原来一致（图标 + 「新增便笺」） */}
          <button
            className="wdlg-btn wdlg-wide"
            onClick={() => setSelected({ kind: "note", id: onCreate() })}
            title="新增便笺"
          >
            <IconNew />
            新增便笺
          </button>
          {/* 待办按钮：同款样式（颜色与「新增便笺」一致，不做绿色语义） */}
          <button
            className="wdlg-btn wdlg-wide"
            onClick={() => setSelected({ kind: "todo", id: onCreateTodo() })}
            title="新增待办"
          >
            <IconTodoNew />
            新增待办
          </button>
        </>
      }
    >
      <div className="nb-inner">
        <div
          className={"nb-list" + (dragId ? " sorting" : "")}
          ref={listRef}
        >
          <div className="nb-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={"nb-tab" + (t.key === tab ? " on" : "")}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {rows.length === 0 && (
            <div className="nb-empty">
              {tab === "todo" ? "还没有待办" : "还没有便笺"}
            </div>
          )}
          {rows.map((r, i) => {
            const isNote = r.kind === "note";
            const id = isNote ? r.note.id : r.todo.id;
            const pinned = isNote ? !!r.note.pinned : !!r.todo.pinned;
            const done = !isNote && r.todo.done;
            const canDrag = reorderable(r);
            return (
              <div
                key={id}
                data-id={id}
                className={
                  "nb-row" +
                  (current && r.kind === selected?.kind && id === selected.id ? " on" : "") +
                  (id === dragId ? " dragging" : "") +
                  (done ? " done" : "") +
                  (dropAt === i ? " drop-top" : "") +
                  (dropAt === i + 1 && i === rows.length - 1 ? " drop-bottom" : "")
                }
                onClick={() =>
                  setSelected({ kind: r.kind, id })
                }
              >
                {canDrag ? (
                  <span
                    className="nb-grip"
                    title="拖动调整顺序"
                    onPointerDown={(e) => onHandleDown(e, id)}
                    onPointerMove={onHandleMove}
                    onPointerUp={onHandleUp}
                    onPointerCancel={onHandleUp}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <IconDrag />
                  </span>
                ) : (
                  // 占位：全部 Tab / 已完成待办不支持拖拽，保持行首对齐
                  <span className="nb-grip empty" />
                )}
                {!isNote && (
                  <button
                    className={"nb-check" + (done ? " on" : "")}
                    title={done ? "取消完成" : "完成待办"}
                    aria-label={done ? "取消完成" : "完成待办"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleDone(id);
                    }}
                  >
                    <IconCheck />
                  </button>
                )}
                <div className="nb-row-main">
                  <div className="nb-row-text">
                    {tab === "all" && (
                      <span className={"nb-kind" + (isNote ? "" : " todo")}>
                        {isNote ? "便笺" : "待办"}
                      </span>
                    )}
                    {pinned && <span className="nb-pin-mark">置顶</span>}
                    {isNote ? preview(r.note.text) : r.todo.title || "（无标题）"}
                  </div>
                  <div className="nb-row-time">
                    {isNote ? stamp(r.note.updatedAt) : todoStamp(r.todo)}
                  </div>
                </div>
                <div className="nb-row-ops">
                  {!done && (
                    <button
                      className={"nb-op icon" + (pinned ? " active" : "")}
                      title={pinned ? "取消置顶" : "置顶"}
                      aria-label={pinned ? "取消置顶" : "置顶"}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isNote) onTogglePin(id);
                        else onTogglePinTodo(id);
                      }}
                    >
                      <IconPin />
                    </button>
                  )}
                  {!done && (
                    <button
                      className="nb-op icon"
                      title="挂起"
                      aria-label="挂起"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isNote) onHang(id);
                        else onHangTodo(id);
                      }}
                    >
                      <IconHang />
                    </button>
                  )}
                  <button
                    className="nb-op icon danger"
                    title="删除"
                    aria-label="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isNote) onDelete(id);
                      else onDeleteTodo(id);
                    }}
                  >
                    <IconTrash />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="nb-content">
          {current ? (
            current.kind === "todo" ? (
              <div className="nb-todo-edit">
                <TodoFields
                  value={todoDraftOf(current.todo)}
                  onChange={(d) => onEditTodo(current.todo.id, d)}
                />
              </div>
            ) : (
              <textarea
                className="nb-text nb-edit"
                value={value}
                placeholder="写点什么…"
                spellCheck={false}
                onChange={(e) => {
                  setDraft(e.target.value);
                  onEdit(current.note.id, e.target.value);
                }}
                onBlur={() => onEditEnd(current.note.id)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            )
          ) : (
            <div className="nb-placeholder">
              <div className="nb-ph-text">
                {tab === "todo"
                  ? "请选择待办，若无待办点击顶部新增按钮创建"
                  : "请选择便笺或待办，若无内容点击顶部新增按钮创建"}
              </div>
            </div>
          )}
        </div>
      </div>
    </WindowDialog>
  );
}
