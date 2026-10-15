import { useEffect, useRef } from "react";

export interface MenuItemDef {
  label?: string;
  onClick?: () => void;
  danger?: boolean;
  bold?: boolean;
  separator?: boolean;
  disabled?: boolean;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItemDef[];
}

export default function ContextMenu({
  menu,
  onClose,
}: {
  menu: MenuState | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 延迟挂载，避免吞掉触发本次菜单的 mouseup/click
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", close);
      window.addEventListener("keydown", onKey);
      window.addEventListener("contextmenu", close, true);
    }, 60);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", close, true);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  // 宽度方向约束；高度方向由 App 在菜单打开时临时加高窗口容纳
  const maxX = window.innerWidth - 230;
  const x = Math.min(menu.x, Math.max(8, maxX));
  const y = Math.max(8, menu.y);

  return (
    <div className="ctx-menu glass-strong" ref={ref} style={{ left: x, top: y }}>
      {menu.items.map((it, i) =>
        it.separator ? (
          <div className="ctx-sep" key={i} />
        ) : (
          <button
            key={i}
            className={"ctx-item" + (it.danger ? " danger" : "") + (it.bold ? " bold" : "")}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick?.();
            }}
          >
            <span>{it.label}</span>
          </button>
        )
      )}
    </div>
  );
}
