import { useEffect, useRef, useState } from "react";

interface Section {
  title: string;
  rows: string[][];
}

// 左右两栏内容（行数相近，避免出现滚动条）
const LEFT: Section[] = [
  {
    title: "唤出 / 收起",
    rows: [
      ["双击托盘图标", "显示或收起晾衣绳"],
      ["鼠标贴到屏幕顶部", "稍作停留即唤出"],
      ["截图或复制文件", "绳子自动出现，文件挂上新卡片"],
      ["空闲约 2 秒", "自动滑回收起，内容不会丢失"],
    ],
  },
  {
    title: "挂上卡片",
    rows: [
      ["拖文件 / 文件夹到屏幕顶部", "松手即挂上绳子"],
      ["复制到剪贴板的图片和文件", "自动晾成新卡片"],
    ],
  },
  {
    title: "托盘菜单（右键托盘图标）",
    rows: [
      ["开机启动", "随系统自动运行"],
      ["卡片大小", "切换 小 / 中 / 大 三档显示"],
    ],
  },
];

const RIGHT: Section[] = [
  {
    title: "卡片操作",
    rows: [
      ["单击卡片", "复制该文件到剪贴板"],
      ["双击卡片", "用默认程序打开"],
      ["按住卡片向外拖", "作为文件拖进聊天窗口、编辑器"],
      ["右键卡片", "打开、定位、取下、全部另存为等"],
      ["悬停卡片右上角 ×", "取下这张卡片"],
    ],
  },
  {
    title: "回看历史",
    rows: [
      ["在绳子上滚动滚轮", "左右滑动回看更早的卡片"],
      ["点击两端的折叠堆叠", "展开列表，直接跳到某张卡片"],
    ],
  },
];

const CARD_W = 580;

function Sec({ s }: { s: Section }) {
  return (
    <section className="help-sec">
      <h3>{s.title}</h3>
      {s.rows.map(([k, v]) => (
        <div className="help-row" key={k}>
          <div className="help-k">{k}</div>
          <div className="help-v">{v}</div>
        </div>
      ))}
    </section>
  );
}

export default function HelpDialog({
  onRect,
  onDragStart,
  onDragEnd,
  onClose,
}: {
  /** 弹窗矩形变化（挂载 + 拖动结束），驱动 Rust 端点击命中区上报 */
  onRect: (r: { x: number; y: number; w: number; h: number }) => void;
  /** 拖动开始：强制窗口非穿透（全屏窗口下拖动中命中区可能滞后） */
  onDragStart: () => void;
  /** 拖动结束：恢复命中区驱动 */
  onDragEnd: () => void;
  onClose: () => void;
}) {
  // 弹窗位置：初始居中偏上，拖动标题栏移动（clamp 在全屏窗口内）
  const [pos, setPos] = useState(() => ({
    x: Math.max(8, Math.round((window.innerWidth - CARD_W) / 2)),
    y: 22,
  }));
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  // 挂载时上报初始矩形（窗口已全屏化，弹窗即点即用）
  useEffect(() => {
    const card = document.getElementById("help-card");
    if (card) {
      const r = card.getBoundingClientRect();
      onRect({
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc / 点击弹窗外部关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      const card = document.getElementById("help-card");
      if (card && !card.contains(e.target as Node)) onClose();
    };
    // 延迟挂载，避免吞掉触发本次弹窗的事件
    const t = window.setTimeout(() => {
      window.addEventListener("keydown", onKey);
      window.addEventListener("mousedown", onDown);
    }, 80);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const onHeadDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return; // 关闭按钮不触发拖动
    const card = document.getElementById("help-card");
    if (!card) return;
    const r = card.getBoundingClientRect();
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onDragStart();
  };
  const onHeadMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const card = document.getElementById("help-card");
    if (!d || !card) return;
    const x = Math.max(
      8,
      Math.min(window.innerWidth - card.offsetWidth - 8, d.ox + e.clientX - d.sx),
    );
    const y = Math.max(
      4,
      Math.min(window.innerHeight - card.offsetHeight - 8, d.oy + e.clientY - d.sy),
    );
    setPos({ x, y });
  };
  const onHeadUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    onDragEnd();
    // 拖动结束：上报最终矩形，更新点击命中区
    const card = document.getElementById("help-card");
    if (card) {
      const r = card.getBoundingClientRect();
      onRect({
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
  };

  return (
    <div className="help-wrap">
      <div
        className="card help-card"
        id="help-card"
        style={{ left: pos.x, top: pos.y }}
      >
        <button className="card-x help-x" onClick={onClose} aria-label="关闭">
          <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden>
            <path
              d="M1 1 L9 9 M9 1 L1 9"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </button>
        <div className="help-inner">
          <div
            className="help-head"
            onPointerDown={onHeadDown}
            onPointerMove={onHeadMove}
            onPointerUp={onHeadUp}
            onPointerCancel={onHeadUp}
          >
            <div className="help-title">使用说明</div>
            <div className="help-sub">
              晾衣绳 · 把复制和拖入的文件晾在屏幕顶端，随取随用
            </div>
          </div>
          <div className="help-body">
            <div className="help-cols">
              <div className="help-col">
                {LEFT.map((s) => (
                  <Sec s={s} key={s.title} />
                ))}
              </div>
              <div className="help-col">
                {RIGHT.map((s) => (
                  <Sec s={s} key={s.title} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
