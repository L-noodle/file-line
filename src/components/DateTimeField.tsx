import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const p2 = (n: number) => String(n).padStart(2, "0");

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const MONTHS = range(12).map((i) => i + 1);
const HOURS = range(24);
const MINUTES = range(60);

/** 时间戳 → 触发按钮展示串（2026-10-20 09:30） */
function fmt(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(
    d.getHours()
  )}:${p2(d.getMinutes())}`;
}

/** 弹窗标题展示串（2026年10月20日 09:30） */
function fmtCn(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p2(
    d.getHours()
  )}:${p2(d.getMinutes())}`;
}

/** 某年某月的天数（month 为 1~12） */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** 日期溢出兜底：如 1月31日 切到 2月 → 2月最后一天 */
function clampDay(d: Date): Date {
  const dim = daysInMonth(d.getFullYear(), d.getMonth() + 1);
  if (d.getDate() > dim) d.setDate(dim);
  return d;
}

/** 单个滚动列表列（年 / 月 / 日 / 时 / 分 共用） */
function PickCol({
  label,
  items,
  selected,
  onPick,
}: {
  label: string;
  items: number[];
  selected: number;
  onPick: (v: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // 打开 / 选中项变化：把选中项滚到列表中间
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const on = list.querySelector<HTMLElement>(".dt-opt.on");
    if (on) list.scrollTop = on.offsetTop - (list.clientHeight - on.offsetHeight) / 2;
  }, [selected]);

  return (
    <div className="dt-col">
      <span className="dt-col-label">{label}</span>
      <div className="dt-col-list" ref={listRef}>
        {items.map((v) => (
          <button
            key={v}
            type="button"
            className={"dt-opt" + (v === selected ? " on" : "")}
            onClick={() => onPick(v)}
          >
            {p2(v)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 日期 + 时间选择器（统一下拉）：
 * 触发按钮显示当前值，点开是一个面板，年 / 月 / 日 / 时 / 分五个滚动列表
 * 并列，点选即生效（触发按钮实时回显），面板底部可一键清除。
 *
 * 为什么不用 <input type="datetime-local">：macOS 的 WKWebView 不渲染
 * 时 / 分下拉列表（时间部分只有文本框，Windows 的 WebView2 有列表），
 * 两端体验不一致；自绘下拉后两端完全一致。
 *
 * 取值口径（待办 / 倒计时都是分钟精度）：
 * - 未设置时打开面板 → 草稿取「现在」，用户点选后才真正提交
 * - 面板通过 portal 渲染到 body，并钳制在所弹出的窗口卡片内——
 *   命中区是按卡片矩形上报的，超出卡片会被 macOS 的点击穿透吞掉
 */
export default function DateTimeField({
  value,
  onChange,
}: {
  /** 时间戳（0 = 未设置） */
  value: number;
  onChange: (ms: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // 面板内的草稿：打开时取当前值；未设置则取「现在」，用户改动后才提交
  const [draft, setDraft] = useState<Date | null>(null);

  const openPop = () => {
    setDraft(value ? new Date(value) : new Date());
    setOpen(true);
  };

  // 面板定位：优先在触发按钮下方；下方放不下翻到上方，再不行贴着卡片底边。
  // 始终钳制在所弹出的窗口卡片内（见上面的说明）
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const pop = popRef.current;
    const trig = triggerRef.current;
    if (!pop || !trig) return;
    const t = trig.getBoundingClientRect();
    const card = trig.closest(".wdlg-card");
    const c: { left: number; top: number; right: number; bottom: number } = card
      ? card.getBoundingClientRect()
      : {
          left: 8,
          top: 8,
          right: window.innerWidth - 8,
          bottom: window.innerHeight - 8,
        };
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const pad = 6;
    const left = Math.max(c.left + pad, Math.min(t.left, c.right - pad - pw));
    let top = t.bottom + 4;
    if (top + ph > c.bottom - pad) top = t.top - ph - 4;
    if (top < c.top + pad) top = Math.max(c.top + pad, c.bottom - pad - ph);
    setPos({ left: Math.round(left), top: Math.round(top) });
  }, [open]);

  // 点面板 / 触发按钮之外关闭；Esc 关闭（捕获阶段，先于弹窗自身的处理）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && (popRef.current?.contains(t) || triggerRef.current?.contains(t)))
        return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // 延迟挂载，避免吞掉触发本次打开的鼠标事件
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // 按键不冒泡到面板（避免误触窗口级快捷键；编辑器容器还会再拦一次）
  const stopKey = (e: React.KeyboardEvent) => e.stopPropagation();

  // 面板打开时草稿必然非空（打开时初始化）；关闭态不渲染面板，守卫不会触发
  const d = draft;
  const pick = (next: Date) => {
    setDraft(next);
    onChange(next.getTime());
  };
  const onYear = (y: number) => {
    if (!d) return;
    const n = new Date(d);
    n.setFullYear(y);
    pick(clampDay(n));
  };
  const onMonth = (mo: number) => {
    if (!d) return;
    const n = new Date(d);
    n.setMonth(mo - 1);
    pick(clampDay(n));
  };
  const onDay = (day: number) => {
    if (!d) return;
    const n = new Date(d);
    n.setDate(day);
    pick(n);
  };
  const onHour = (h: number) => {
    if (!d) return;
    const n = new Date(d);
    n.setHours(h);
    pick(n);
  };
  const onMinute = (mi: number) => {
    if (!d) return;
    const n = new Date(d);
    n.setMinutes(mi);
    pick(n);
  };

  // 年份列表以当前草稿年份为中心（老数据不会落在列表外）
  const base = d ?? new Date();
  const y0 = base.getFullYear() - 5;
  const years = Array.from({ length: 16 }, (_, i) => y0 + i);
  const days = range(daysInMonth(base.getFullYear(), base.getMonth() + 1)).map(
    (i) => i + 1
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={"dt-trigger" + (value ? "" : " empty")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPop())}
        onKeyDown={stopKey}
      >
        <span className="dt-trigger-text">{value ? fmt(value) : "未设置"}</span>
        <svg className="dt-chev" viewBox="0 0 10 6" width="9" height="6" aria-hidden>
          <path
            d="M1 1l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && d && createPortal(
        <div
          ref={popRef}
          className="dt-pop"
          role="dialog"
          aria-label="选择日期和时间"
          style={{
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            visibility: pos ? undefined : "hidden",
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            }
          }}
        >
          <div className="dt-pop-title">{fmtCn(d)}</div>
          <div className="dt-cols">
            <PickCol label="年" items={years} selected={d.getFullYear()} onPick={onYear} />
            <PickCol label="月" items={MONTHS} selected={d.getMonth() + 1} onPick={onMonth} />
            <PickCol label="日" items={days} selected={d.getDate()} onPick={onDay} />
            <span className="dt-cols-sep" />
            <PickCol label="时" items={HOURS} selected={d.getHours()} onPick={onHour} />
            <PickCol label="分" items={MINUTES} selected={d.getMinutes()} onPick={onMinute} />
          </div>
          <button
            type="button"
            className="dt-pop-clear"
            onClick={() => {
              onChange(0);
              setOpen(false);
            }}
          >
            清除时间
          </button>
        </div>,
        document.body
      )}
    </>
  );
}
