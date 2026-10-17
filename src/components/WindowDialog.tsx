import { useEffect, useRef, useState } from "react";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  /** DOM id（量取矩形用） */
  id: string;
  title: string;
  width: number;
  /** 弹窗矩形变化（卸载时传 null 撤销），驱动 Rust 端点击命中区上报 */
  onRect: (r: Rect | null) => void;
  onClose: () => void;
  /** 标题栏右侧的额外按钮（打勾等），渲染在关闭按钮左侧 */
  headRight?: React.ReactNode;
  /** 层级（同一时刻可开多个弹窗，数字大的在上面） */
  z?: number;
  /** 被点击 / 拖动时置顶 */
  onFocus?: () => void;
  children: React.ReactNode;
  /** 点击弹窗外部关闭（便笺编辑器关掉，避免误触丢内容） */
  closeOnOutside?: boolean;
  bodyClassName?: string;
}

/**
 * 窗口样式弹窗：顶部标题栏（左标题 / 右按钮）+ 内容区，可拖动。
 * 打开时 App 会把窗口临时全屏化，这里按屏幕居中并上报矩形给命中区。
 */
const BASE_Z = 1250;

export default function WindowDialog({
  id,
  title,
  width,
  onRect,
  onClose,
  headRight,
  z,
  onFocus,
  children,
  closeOnOutside,
  bodyClassName,
}: Props) {
  const [pos, setPos] = useState(() => ({
    x: Math.max(8, Math.round((window.innerWidth - width) / 2)),
    y: 80,
  }));
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(
    null
  );
  const movedRef = useRef(false);

  const report = () => {
    const card = document.getElementById(id);
    if (!card) return;
    const r = card.getBoundingClientRect();
    onRect({
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  };

  // 位置变化后上报矩形（挂载 / 居中校正）
  useEffect(() => {
    if (dragRef.current) return;
    report();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos]);

  // 卸载：撤销本弹窗的命中区（多个弹窗可同时打开，各自上报各自的矩形）
  useEffect(() => {
    return () => onRect(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 居中：挂载时窗口可能还是顶部条带（全屏化异步完成），先按 screen 估算，
  // window resize（全屏化完成）后按实际窗口尺寸精算
  useEffect(() => {
    const center = (useScreen: boolean) => {
      if (movedRef.current) return;
      const card = document.getElementById(id);
      const h = card?.offsetHeight ?? 0;
      if (!h) return;
      const viewH = useScreen ? window.screen.height : window.innerHeight;
      setPos({
        x: Math.max(8, Math.round((window.innerWidth - width) / 2)),
        y: Math.max(8, Math.round((viewH - h) / 2)),
      });
    };
    center(true);
    const onResize = () => center(false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (!closeOnOutside) return;
      const t = e.target;
      if (t instanceof Element && t.closest(".panel")) return;
      onClose();
    };
    const t = window.setTimeout(() => {
      window.addEventListener("keydown", onKey);
      if (closeOnOutside) window.addEventListener("mousedown", onDown);
    }, 80);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose, closeOnOutside]);

  const onHeadDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const card = document.getElementById(id);
    if (!card) return;
    const r = card.getBoundingClientRect();
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
    movedRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHeadMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const card = document.getElementById(id);
    if (!d || !card) return;
    setPos({
      x: Math.max(8, Math.min(window.innerWidth - card.offsetWidth - 8, d.ox + e.clientX - d.sx)),
      y: Math.max(4, Math.min(window.innerHeight - card.offsetHeight - 8, d.oy + e.clientY - d.sy)),
    });
  };
  const onHeadUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    report();
  };

  return (
    <div className="wdlg-wrap" style={{ zIndex: BASE_Z + (z ?? 0) }}>
      <div
        className="card wdlg-card"
        id={id}
        style={{ left: pos.x, top: pos.y, width }}
        // 按下即置顶（多个弹窗各占一个层级，点谁谁在上面）
        onPointerDownCapture={() => onFocus?.()}
      >
        <div className="wdlg-inner">
          <div
            className="wdlg-head"
            onPointerDown={onHeadDown}
            onPointerMove={onHeadMove}
            onPointerUp={onHeadUp}
            onPointerCancel={onHeadUp}
          >
            <div className="wdlg-title">{title}</div>
            <div className="wdlg-actions">
              {headRight}
              <button className="wdlg-btn wdlg-close" onClick={onClose} aria-label="关闭">
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
            </div>
          </div>
          <div className={"wdlg-body" + (bodyClassName ? " " + bodyClassName : "")}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
