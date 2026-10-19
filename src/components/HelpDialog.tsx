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
      ["新增便笺", "新建便笺并挂到绳子上，直接开写"],
      ["新增待办", "新建待办并挂到绳子上，设置时间与提醒"],
      ["新增倒计时", "新建倒计时并挂到绳子上，实时倒数至截止"],
      ["打开笔记本", "管理全部便笺与待办（置顶 / 挂起 / 删除）"],
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
      ["拖动卡片上的衣夹", "沿绳子左右移动，调整卡片顺序"],
      ["按住卡片向外拖", "作为文件拖进聊天窗口、编辑器"],
      ["点击最右入口卡片", "左图新建便笺，中图新建待办，下行新建倒计时，右图打开笔记本"],
      ["右键卡片", "打开、定位、取下、全部另存为等"],
      ["悬停卡片右上角 ×", "取下这张卡片"],
    ],
  },
  {
    title: "待办卡片",
    rows: [
      ["单击待办卡片", "打开详情弹窗（只展示标题和内容）"],
      ["双击待办卡片", "打开编辑弹窗（可修改全部内容）"],
      ["悬停右上角绿色 ✓", "标记完成，并把卡片从绳上取下"],
      ["到点自动提醒", "顶部弹出消息（标题 + 内容），可稍后 N 分钟再提醒或关闭"],
      ["笔记本 → 待办 Tab", "查看全部待办，完成的排在最后；勾选框可完成 / 取消"],
    ],
  },
  {
    title: "倒计时卡片",
    rows: [
      ["双击倒计时卡片", "打开编辑弹窗（名称 / 内容 / 截止日期）"],
      ["底部倒数条", "天/时/分/秒渐近展示，不足天不展示天；截止后显示「已截止」"],
      ["笔记本 → 限时 Tab", "查看全部倒计时，全部 Tab 里穿插展示，可置顶 / 挂起 / 删除"],
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
  // 弹窗位置：屏幕居中（挂载时窗口可能尚未完成全屏化，先按屏幕尺寸估算，
  // resize 后精算），拖动标题栏移动（clamp 在全屏窗口内）
  const [pos, setPos] = useState(() => ({
    x: Math.max(8, Math.round((window.innerWidth - CARD_W) / 2)),
    y: Math.max(4, Math.round((window.screen.height - 600) / 2)), // 高度先估算，量到实际值后校正
  }));
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const movedRef = useRef(false); // 用户拖动过后不再自动居中

  // 位置变化后上报矩形（挂载 / 居中校正），驱动 Rust 端点击命中区
  useEffect(() => {
    if (dragRef.current) return; // 拖动中不上报，结束时统一上报
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
  }, [pos]);

  // 屏幕居中：挂载时窗口可能还是顶部条带（全屏化是异步的），先用 screen 尺寸
  // 加实际卡片高度校正；窗口 resize（全屏化完成）后按窗口尺寸精算
  useEffect(() => {
    const center = (useScreen: boolean) => {
      if (movedRef.current) return;
      const card = document.getElementById("help-card");
      const h = card?.offsetHeight ?? 0;
      if (!h) return;
      const viewH = useScreen ? window.screen.height : window.innerHeight;
      setPos({
        x: Math.max(8, Math.round((window.innerWidth - CARD_W) / 2)),
        y: Math.max(4, Math.round((viewH - h) / 2)),
      });
    };
    center(true);
    const onResize = () => center(false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Esc / 点击弹窗外部关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      // 弹窗与晾衣绳面板（卡片 / 菜单等）内的点击不关闭——阅读说明期间
      // 卡片交互保持可用；穿透区域的点击到不了 WebView，能走到这里的
      // 只有强制捕获期间点到的窗口空白
      const t = e.target;
      if (t instanceof Element && t.closest(".panel")) return;
      onClose();
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
    movedRef.current = true; // 用户自己定位后，resize 不再重置位置
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
