import type { Todo } from "../types";

/** 待办编辑草稿（创建 / 编辑弹窗与笔记本右侧面板共用） */
export interface TodoDraft {
  title: string;
  text: string;
  startAt: number;
  endAt: number;
  repeat: boolean;
  remindStart: number | null;
  remindEnd: number | null;
}

export const emptyTodoDraft = (): TodoDraft => ({
  title: "",
  text: "",
  startAt: 0,
  endAt: 0,
  repeat: false,
  remindStart: null,
  remindEnd: null,
});

export const todoDraftOf = (t: Todo): TodoDraft => ({
  title: t.title,
  text: t.text,
  startAt: t.startAt,
  endAt: t.endAt,
  repeat: t.repeat,
  remindStart: t.remindStart,
  remindEnd: t.remindEnd,
});

/** 时间戳 → datetime-local 的本地时间串（空串 = 未设置） */
export function toLocalInput(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

/** datetime-local 本地串 → 时间戳（空 / 非法 → 0） */
export function fromLocalInput(v: string): number {
  if (!v) return 0;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * 待办表单字段：标题 / 内容 / 开始时间 / 结束时间 / 是否重复 /
 * 开始前提醒（分钟）/ 结束前提醒（分钟）。
 * 创建弹窗与笔记本右侧编辑面板共用同一份字段。
 */
export default function TodoFields({
  value,
  onChange,
}: {
  value: TodoDraft;
  onChange: (d: TodoDraft) => void;
}) {
  const set = (patch: Partial<TodoDraft>) => onChange({ ...value, ...patch });
  // 勾选提醒时给个默认分钟数（之后用户可自己改）
  const remindVal = (n: number | null, fallback: number) => n ?? fallback;

  return (
    <div className="todo-form">
      <div className="todo-fld">
        <span className="todo-lbl">标题</span>
        <input
          className="todo-input"
          value={value.title}
          placeholder="待办标题"
          spellCheck={false}
          onChange={(e) => set({ title: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      <div className="todo-fld">
        <span className="todo-lbl">内容</span>
        <textarea
          className="todo-input todo-ta"
          value={value.text}
          placeholder="待办内容…"
          spellCheck={false}
          onChange={(e) => set({ text: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      <div className="todo-fld-row">
        <div className="todo-fld">
          <span className="todo-lbl">开始时间</span>
          <input
            type="datetime-local"
            className="todo-input"
            value={toLocalInput(value.startAt)}
            onChange={(e) => set({ startAt: fromLocalInput(e.target.value) })}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>
        <div className="todo-fld">
          <span className="todo-lbl">结束时间</span>
          <input
            type="datetime-local"
            className="todo-input"
            value={toLocalInput(value.endAt)}
            onChange={(e) => set({ endAt: fromLocalInput(e.target.value) })}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>
      </div>
      <div className="todo-check-row">
        <input
          type="checkbox"
          id="todo-repeat"
          checked={value.repeat}
          onChange={(e) => set({ repeat: e.target.checked })}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <label htmlFor="todo-repeat">是否重复（每天同一时间再次提醒）</label>
      </div>
      <div className="todo-fld-row">
        <div className={"todo-rem" + (value.remindStart != null ? " on" : "")}>
          <input
            type="checkbox"
            id="todo-remind-start"
            checked={value.remindStart != null}
            onChange={(e) =>
              set({ remindStart: e.target.checked ? remindVal(value.remindStart, 5) : null })
            }
            onKeyDown={(e) => e.stopPropagation()}
          />
          <label htmlFor="todo-remind-start">开始前提醒</label>
          <input
            type="number"
            className="todo-num"
            min={1}
            max={1440}
            disabled={value.remindStart == null}
            value={value.remindStart ?? ""}
            onChange={(e) =>
              set({
                remindStart: Math.max(1, Math.min(1440, Number(e.target.value) || 1)),
              })
            }
            onKeyDown={(e) => e.stopPropagation()}
          />
          <span className="todo-unit">分钟之前</span>
        </div>
        <div className={"todo-rem" + (value.remindEnd != null ? " on" : "")}>
          <input
            type="checkbox"
            id="todo-remind-end"
            checked={value.remindEnd != null}
            onChange={(e) =>
              set({ remindEnd: e.target.checked ? remindVal(value.remindEnd, 5) : null })
            }
            onKeyDown={(e) => e.stopPropagation()}
          />
          <label htmlFor="todo-remind-end">结束前提醒</label>
          <input
            type="number"
            className="todo-num"
            min={1}
            max={1440}
            disabled={value.remindEnd == null}
            value={value.remindEnd ?? ""}
            onChange={(e) =>
              set({
                remindEnd: Math.max(1, Math.min(1440, Number(e.target.value) || 1)),
              })
            }
            onKeyDown={(e) => e.stopPropagation()}
          />
          <span className="todo-unit">分钟之前</span>
        </div>
      </div>
    </div>
  );
}
