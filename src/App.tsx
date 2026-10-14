import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import Rope from "./components/Rope";
import PeggedCard from "./components/PeggedCard";
import Clothespin from "./components/Clothespin";
import OverflowFan from "./components/OverflowFan";
import ContextMenu, { MenuState } from "./components/ContextMenu";
import type { Item } from "./types";
import { api } from "./api";
import {
  cardWidth,
  panelHeight,
  photoMaxHeight,
  PIN_ABOVE,
  ropeY,
  SizeKey,
  spacing,
  visibleCapacity,
  visibleX,
} from "./layout";
import { invoke } from "@tauri-apps/api/core";

let seq = 1;
const nextId = () => `i${seq++}`;

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [size, setSize] = useState<SizeKey>("medium");
  const [revealed, setRevealed] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [width, setWidth] = useState(window.innerWidth);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef(0);
  const menuRef = useRef<MenuState | null>(null);
  menuRef.current = menu;

  // ---------- 显示 / 隐藏状态机 ----------
  const revealedRef = useRef(false);
  revealedRef.current = revealed;
  const hoverRef = useRef(false); // 鼠标是否在面板区域内
  const dragActiveRef = useRef(false); // 正在拖拽卡片
  const hideTimer = useRef(0); // 3s 闲置计时
  const animTimer = useRef(0); // 滑出动画后隐藏窗口
  const HIDE_DELAY = 3000;
  const ANIM_MS = 330;

  const cancelHide = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    window.clearTimeout(animTimer.current);
  }, []);

  const hideNow = useCallback(() => {
    if (!revealedRef.current) return;
    cancelHide();
    setRevealed(false);
    // 等滑出动画结束后隐藏窗口
    animTimer.current = window.setTimeout(() => {
      if (revealedRef.current) return; // 期间又被唤起
      api.hideRope().catch(console.error);
    }, ANIM_MS);
  }, [cancelHide]);

  const scheduleHide = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    if (!revealedRef.current) return;
    if (hoverRef.current || dragActiveRef.current || menuRef.current) return;
    hideTimer.current = window.setTimeout(hideNow, HIDE_DELAY);
  }, [hideNow]);

  const reveal = useCallback(() => {
    cancelHide();
    if (!revealedRef.current) {
      api.showRope().catch(console.error);
      setRevealed(true);
      // 绳子出现：卡片被风带动晃动（PeggedCard 监听）
      window.dispatchEvent(new CustomEvent("rope-reveal"));
    }
  }, [cancelHide]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;

  // ---------- 初始化 ----------
  useEffect(() => {
    (async () => {
      try {
        const st = await api.getState();
        if (st.size === "small" || st.size === "medium" || st.size === "large") {
          setSize(st.size);
        }
        if (Array.isArray(st.items)) {
          for (const it of st.items) {
            await addItem(it.path, it.source === "drag" ? "drag" : "clip");
          }
        }
      } catch (e) {
        console.error(e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 事件监听 ----------
  useEffect(() => {
    const un1 = listen<{ paths: string[] }>("clip-new", (e) => {
      addPaths(e.payload.paths, "clip");
      reveal(); // 截图进剪贴板 → 唤出绳子
    });
    const un2 = listen<string>("size-changed", (e) => {
      if (e.payload === "small" || e.payload === "medium" || e.payload === "large") {
        setSize(e.payload);
      }
    });
    const un3 = listen("tray-toggle", () => {
      if (revealedRef.current) hideNow();
      else reveal();
    });
    // 拖拽文件到屏幕顶部 100px 持续 0.3s → 显示
    const un5 = listen("show-rope", () => reveal());
    // 鼠标进入 / 离开面板区域（驱动闲置隐藏）
    const un6 = listen<boolean>("panel-hover", (e) => {
      hoverRef.current = !!e.payload;
      if (hoverRef.current) cancelHide();
      else scheduleHide();
    });
    // 卡片拖拽进行中：不自动隐藏
    const onDragStart = () => {
      dragActiveRef.current = true;
      cancelHide();
    };
    const onDragEnd = () => {
      dragActiveRef.current = false;
      scheduleHide();
    };
    window.addEventListener("card-drag-start", onDragStart);
    window.addEventListener("card-drag-end", onDragEnd);
    // 拖入文件 / 文件夹
    const un4 = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "drop") {
        addPaths(e.payload.paths, "drag");
        reveal();
      }
    });
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    // 阵风：7~16s 随机摆动
    let gustTimer = 0;
    const scheduleGust = () => {
      gustTimer = window.setTimeout(
        () => {
          window.dispatchEvent(
            new CustomEvent("gust", { detail: 1.6 + Math.random() * 1.8 })
          );
          scheduleGust();
        },
        7000 + Math.random() * 9000
      );
    };
    scheduleGust();
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
      un3.then((f) => f());
      un4.then((f) => f());
      un5.then((f) => f());
      un6.then((f) => f());
      window.removeEventListener("card-drag-start", onDragStart);
      window.removeEventListener("card-drag-end", onDragEnd);
      window.removeEventListener("resize", onResize);
      window.clearTimeout(gustTimer);
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(animTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 增删 ----------
  const addItem = useCallback(async (path: string, source: "drag" | "clip") => {
    if (itemsRef.current.some((it) => it.path === path)) return;
    const name = path.split(/[\\/]/).pop() || path;
    let thumb;
    try {
      thumb = await api.makeThumb(path, 320);
      if (thumb.error) throw thumb.error;
    } catch {
      thumb = undefined;
    }
    const item: Item = {
      id: nextId(),
      path,
      name,
      kind: thumb?.kind ?? "file",
      thumb,
      tilt: (Math.random() * 2 - 1) * 2.5,
      index: seq,
      source,
    };
    setItems((prev) =>
      prev.some((p) => p.path === path) ? prev : [...prev, item]
    );
  }, []);

  const addPaths = useCallback(
    async (paths: string[], source: "drag" | "clip") => {
      for (const p of paths) {
        await addItem(p, source);
      }
    },
    [addItem]
  );

  // 持久化
  useEffect(() => {
    api
      .saveState(items.map((i) => ({ path: i.path, source: i.source })))
      .catch(console.error);
  }, [items]);

  // ---------- 菜单 ----------
  const [fallingIds, setFallingIds] = useState<string[]>([]);

  // 掉落动画结束后真正移除
  const removeItems = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setFallingIds((prev) => Array.from(new Set([...prev, ...ids])));
    window.setTimeout(
      () => {
        const s = new Set(ids);
        setItems((prev) => prev.filter((i) => !s.has(i.id)));
        setFallingIds((prev) => prev.filter((f) => !s.has(f)));
      },
      680
    );
  }, []);

  const openCardMenu = (e: React.MouseEvent, item: Item) => {
    e.preventDefault();
    e.stopPropagation();
    // 当前卡片在绳子上的位置（左侧 / 右侧是否有其他卡片）
    const idx = items.findIndex((i) => i.id === item.id);
    const leftIds = items.slice(0, idx).map((i) => i.id);
    const rightIds = items.slice(idx + 1).map((i) => i.id);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "打开",
          onClick: () => api.openPath(item.path).catch(console.error),
        },
        // 仅拖拽进入的文件展示（剪贴板落地的是临时文件，定位无意义）
        ...(item.source === "drag"
          ? [
              {
                label: "打开所在文件夹",
                onClick: () => api.showInFolder(item.path).catch(console.error),
              },
            ]
          : []),
        {
          label: "取下",
          onClick: () => removeItems([item.id]),
        },
        ...(leftIds.length > 0
          ? [
              {
                label: "取下左侧全部",
                onClick: () => removeItems(leftIds),
              },
            ]
          : []),
        ...(rightIds.length > 0
          ? [
              {
                label: "取下右侧全部",
                onClick: () => removeItems(rightIds),
              },
            ]
          : []),
        { separator: true },
        {
          label: "另存为",
          disabled: items.length === 0,
          onClick: async () => {
            const folder = await openDialog({
              directory: true,
              title: "选择保存位置",
            });
            if (typeof folder !== "string" || !folder) return;
            try {
              const saved = await api.saveToFolder(
                items.map((i) => i.path),
                folder
              );
              removeItems(items.map((i) => i.id));
              showToast(`已另存到：${saved}`);
            } catch (err) {
              console.error(err);
              showToast("另存失败");
            }
          },
        },
        {
          label: "清空绳子",
          disabled: items.length === 0,
          danger: true,
          bold: true,
          onClick: () => removeItems(items.map((i) => i.id)),
        },
      ],
    });
  };

  // 菜单打开期间：强制窗口可交互（防止穿透吞掉菜单点击）；关闭后重新计时闲置隐藏
  useEffect(() => {
    invoke("set_capture_override", { on: !!menu }).catch(() => {});
    if (menu) cancelHide();
    else scheduleHide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);

  // ---------- 布局 ----------
  const capacity = visibleCapacity(width, size);
  const visCount = Math.min(items.length, capacity);
  const visibleItems = items
    .slice(items.length - visCount)
    .map((it, i) => ({ item: it, i }));
  const folded = items.slice(0, Math.max(0, items.length - visCount));
  const fanX = width / 2 - ((visCount - 1) / 2) * spacing(size) - spacing(size) - 10;
  const panelH = panelHeight(size);

  // ---------- 命中区上报 ----------
  useEffect(() => {
    const cw = cardWidth(size);
    const ph = photoMaxHeight(size);
    const rects: [number, number, number, number][] = [];
    if (revealed) {
      for (const v of visibleItems) {
        const cx = visibleX(v.i, visCount, width, size);
        const y = ropeY(cx, width) - PIN_ABOVE;
        // 贴合卡片实际 DOM：衣夹 26px + 卡片约 ph+8，只留少量 hover 放大余量，
        // 避免吞掉卡片下方/两侧的鼠标事件（桌面内容保持正常 hover）
        rects.push([cx - cw / 2 - 3, y, cw + 6, 26 + ph + 18]);
      }
      if (folded.length > 0) {
        rects.push([fanX - 48, 24, 96, 104]);
      }
      if (items.length === 0) {
        // 空绳装饰：中间夹着的小图
        const cx = width / 2;
        const py = ropeY(cx, width) - PIN_ABOVE;
        rects.push([cx - 55, py - 4, 110, 100]);
      }
    }
    api.setHitRects(rects, panelH).catch(console.error);
  }, [items, width, size, revealed, menu]);

  return (
    <div className={"panel" + (revealed ? "" : " hidden")} style={{ height: panelH }}>
      <Rope width={width} />
      {items.length === 0 && (
        <div
          className="empty-peg"
          style={{ left: width / 2, top: ropeY(width / 2, width) - PIN_ABOVE }}
        >
          <Clothespin />
          <img
            className="empty-dog"
            src="/perch-dog.png"
            alt=""
            draggable={false}
            style={{ width: Math.round(cardWidth(size) * 0.4) }}
          />
        </div>
      )}
      <OverflowFan
        items={folded}
        x={fanX}
        onOpen={(it) => api.openPath(it.path).catch(console.error)}
      />
      {visibleItems.map(({ item, i }) => (
        <PeggedCard
          key={item.id}
          item={item}
          index={i}
          count={visCount}
          width={width}
          size={size}
          x={visibleX(i, visCount, width, size)}
          onContextMenu={openCardMenu}
          onRemove={(id) => removeItems([id])}
          falling={fallingIds.includes(item.id)}
        />
      ))}
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      {toast && <div className="toast glass-strong">{toast}</div>}
    </div>
  );
}
