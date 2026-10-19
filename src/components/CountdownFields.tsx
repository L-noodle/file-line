import type { Countdown } from "../types";
import DateTimeField from "./DateTimeField";

/** 倒计时编辑草稿（创建 / 编辑弹窗与笔记本右侧面板共用） */
export interface CountdownDraft {
  title: string;
  text: string;
  endAt: number;
}

export const emptyCountdownDraft = (): CountdownDraft => ({
  title: "",
  text: "",
  endAt: 0,
});

export const countdownDraftOf = (c: Countdown): CountdownDraft => ({
  title: c.title,
  text: c.text,
  endAt: c.endAt,
});

/**
 * 倒计时渐近展示：剩余时长 → 只保留最大的两档单位。
 * 三档口径：≥1 天 → 「X天XX小时」；≥1 小时 → 「X小时XX分」；
 * <1 小时 → 「X分XX秒」（只有此时秒才会跳动）；已截止 → 「已截止」。
 */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "已截止";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}天${p(h)}小时`;
  if (h > 0) return `${h}小时${p(m)}分`;
  return `${m}分${p(s)}秒`;
}

/**
 * 倒计时表单字段：名称 / 内容 / 截止日期。
 * 创建弹窗与笔记本右侧编辑面板共用同一份字段。
 */
export default function CountdownFields({
  value,
  onChange,
}: {
  value: CountdownDraft;
  onChange: (d: CountdownDraft) => void;
}) {
  const set = (patch: Partial<CountdownDraft>) => onChange({ ...value, ...patch });

  return (
    <div className="todo-form">
      <div className="todo-fld">
        <span className="todo-lbl">名称</span>
        <input
          className="todo-input"
          value={value.title}
          placeholder="倒计时名称"
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
          placeholder="倒计时内容…"
          spellCheck={false}
          onChange={(e) => set({ text: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      <div className="todo-fld">
        <span className="todo-lbl">截止日期</span>
        <DateTimeField
          value={value.endAt}
          onChange={(ms) => set({ endAt: ms })}
        />
      </div>
    </div>
  );
}
