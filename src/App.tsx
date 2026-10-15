import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, LogicalSize, currentMonitor } from "@tauri-apps/api/window";
import { confirm, open as openDialog } from "@tauri-apps/plugin-dialog";
import Rope from "./components/Rope";
import PeggedCard from "./components/PeggedCard";
import Clothespin from "./components/Clothespin";
import OverflowFan from "./components/OverflowFan";
import ContextMenu, { MenuState } from "./components/ContextMenu";
import HelpDialog from "./components/HelpDialog";
import type { Item } from "./types";
import { api } from "./api";
import {
  cardWidth,
  panelHeight,
  photoMaxHeight,
  PIN_ABOVE,
  REVEAL_BASE,
  REVEAL_DUR,
  revealStagger,
  ropeY,
  SizeKey,
  spacing,
  visibleCapacity,
  visibleX,
} from "./layout";
import { invoke } from "@tauri-apps/api/core";

let seq = 1;
const nextId = () => `i${seq++}`;

// 使用说明弹窗矩形（窗口逻辑坐标）。弹窗打开时窗口临时全屏化，
// 弹窗可全屏随意拖动；该矩形作为点击命中区上报（弹窗外保持穿透）
type HelpRect = { x: number; y: number; w: number; h: number };

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [size, setSize] = useState<SizeKey>("medium");
  const [revealed, setRevealed] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [helpOpen, setHelpOpen] = useState(false); // 使用说明弹窗（托盘菜单触发）
  const [helpRect, setHelpRect] = useState<HelpRect | null>(null); // 弹窗当前矩形（驱动命中区上报）
  const [width, setWidth] = useState(window.innerWidth);
  const [dragHover, setDragHover] = useState(false); // 外部拖拽悬停在可放置区（绳子彩色流动反馈）
  const [scrollPx, setScrollPx] = useState(0); // 滚轮回看偏移 px（0 = 最新卡片靠右）
  const wheelAccRef = useRef(0); // 滚轮累积量（触控板小步事件合并防抖）
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef(0);
  const menuRef = useRef<MenuState | null>(null);
  menuRef.current = menu;
  const helpOpenRef = useRef(false);
  helpOpenRef.current = helpOpen;
  // 右键菜单打开时窗口是否被临时加高（菜单高度动态，可能超出条带窗口）
  const menuExpandedRef = useRef(false);
  // 使用说明弹窗打开期间窗口是否被临时全屏化
  const helpFullRef = useRef(false);

  // ---------- 显示 / 隐藏状态机 ----------
  const revealedRef = useRef(false);
  revealedRef.current = revealed;
  const hoverRef = useRef(false); // 鼠标是否在面板区域内
  const dragActiveRef = useRef(false); // 正在拖拽卡片
  const dragHoverRef = useRef(false); // 外部拖拽悬停在可放置区（OLE enter/leave）
  dragHoverRef.current = dragHover;
  const hideTimer = useRef(0); // 闲置计时
  const animTimer = useRef(0); // 滑出动画后隐藏窗口
  const HIDE_DELAY = 2000;
  const ANIM_MS = 1330;

  const cancelHide = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    window.clearTimeout(animTimer.current);
  }, []);

  const hideNow = useCallback(() => {
    if (!revealedRef.current) return;
    cancelHide();
    setRevealed(false);
    setHelpOpen(false); // 收起绳子时一并关闭使用说明弹窗
    // 等滑出动画结束后隐藏窗口
    animTimer.current = window.setTimeout(() => {
      if (revealedRef.current) return; // 期间又被唤起
      api.hideRope().catch(console.error);
    }, ANIM_MS);
  }, [cancelHide]);

  const scheduleHide = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    if (!revealedRef.current) return;
    if (hoverRef.current || dragActiveRef.current || dragHoverRef.current || menuRef.current || helpOpenRef.current) return;
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
        if (
          st.size === "small" ||
          st.size === "medium" ||
          st.size === "large"
        ) {
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
      if (
        e.payload === "small" ||
        e.payload === "medium" ||
        e.payload === "large"
      ) {
        setSize(e.payload);
      }
    });
    const un3 = listen("tray-toggle", () => {
      if (revealedRef.current) hideNow();
      else reveal();
    });
    // 拖拽文件到屏幕顶部 100px 持续 0.3s → 显示
    const un5 = listen("show-rope", () => reveal());
    // 托盘菜单「使用说明」：唤出绳子并弹出说明弹窗
    const un8 = listen("show-help", () => {
      reveal();
      setHelpOpen(true);
    });
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
    let wiggleDone = false; // 一次拖拽会话只抖一次
    const un4 = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "enter") {
        wiggleDone = false;
      } else if (e.payload.type === "over" && !wiggleDone) {
        wiggleDone = true;
        window.dispatchEvent(new CustomEvent("rope-wiggle"));
      } else if (e.payload.type === "drop") {
        addPaths(e.payload.paths, "drag");
        reveal();
      } else if (e.payload.type === "leave") {
        wiggleDone = false;
      }
    });
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    // 原生 OLE 补注册通道（深层子窗口 drop 直达，绕过 wry 缺失的注册）
    // enter/leave：拖拽悬停/离开可放置区 → 绳子彩色流动反馈
    const un7 = listen<{ paths: string[]; type?: string }>(
      "native-drop",
      (e) => {
        const ty = e.payload.type ?? "drop";
        if (ty === "enter") {
          setDragHover(true);
          cancelHide();
        } else if (ty === "leave") {
          setDragHover(false);
        } else {
          addPaths(e.payload.paths, "drag");
          setDragHover(false);
          reveal();
        }
      },
    );
    // 阵风：7~16s 随机摆动
    let gustTimer = 0;
    const scheduleGust = () => {
      gustTimer = window.setTimeout(
        () => {
          window.dispatchEvent(
            new CustomEvent("gust", { detail: 1.6 + Math.random() * 1.8 }),
          );
          scheduleGust();
        },
        7000 + Math.random() * 9000,
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
      un7.then((f) => f());
      un8.then((f) => f());
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
      prev.some((p) => p.path === path) ? prev : [...prev, item],
    );
    // 新卡片进绳：回到最右端（最新）
    setScrollPx(0);
  }, []);

  const addPaths = useCallback(
    async (paths: string[], source: "drag" | "clip") => {
      for (const p of paths) {
        await addItem(p, source);
      }
    },
    [addItem],
  );

  // 持久化（items 或样式变化时）
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
    window.setTimeout(() => {
      const s = new Set(ids);
      setItems((prev) => prev.filter((i) => !s.has(i.id)));
      setFallingIds((prev) => prev.filter((f) => !s.has(f)));
    }, 680);
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
          label: "打开（双击）",
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
          label: "全部另存为",
          disabled: items.length === 0,
          onClick: async () => {
            // 卡片里包含文件夹：递归复制可能有大数据量，先让用户确认
            if (items.some((i) => i.kind === "folder")) {
              const ok = await confirm(
                "卡片中包含文件夹，另存时将递归复制其全部内容，可能涉及大数据量复制。是否继续？",
                { title: "全部另存为", kind: "warning" },
              );
              if (!ok) return;
            }
            const folder = await openDialog({
              directory: true,
              title: "选择保存位置",
            });
            if (typeof folder !== "string" || !folder) return;
            try {
              const saved = await api.saveToFolder(
                items.map((i) => i.path),
                folder,
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
          label: "清空卡片",
          disabled: items.length === 0,
          danger: true,
          onClick: () => removeItems(items.map((i) => i.id)),
        },
      ],
    });
  };

  // 右键菜单打开期间：强制窗口可交互（防止穿透吞掉菜单点击）；菜单条目数动态，
  // 可能超出条带窗口底部 → 临时加高透明窗口容纳，关闭后恢复条带高度
  useEffect(() => {
    invoke("set_capture_override", { on: !!menu }).catch(() => {});
    if (menu) {
      cancelHide();
      // 弹窗打开时窗口已全屏化，无需再加高
      if (!helpFullRef.current) {
        const need = menu.y + menu.items.length * 34 + 72;
        if (need > window.innerHeight) {
          menuExpandedRef.current = true;
          getCurrentWindow()
            .setSize(new LogicalSize(window.innerWidth, Math.ceil(need)))
            .catch(console.error);
        }
      }
    } else {
      if (menuExpandedRef.current) {
        menuExpandedRef.current = false;
        // 弹窗仍开着则保持全屏，恢复留给弹窗关闭时处理
        if (!helpFullRef.current) {
          invoke("window_resized").catch(console.error);
        }
      }
      scheduleHide();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);

  // 使用说明弹窗：打开时窗口临时全屏化，弹窗即可拖到屏幕任意位置；
  // 关闭后恢复条带窗口（重新铺满顶部）
  useEffect(() => {
    if (helpOpen) {
      cancelHide();
      helpFullRef.current = true;
      (async () => {
        const mon = await currentMonitor();
        const win = getCurrentWindow();
        if (mon) {
          await win.setPosition(mon.position);
          await win.setSize(mon.size);
        }
      })().catch(console.error);
    } else {
      if (helpFullRef.current) {
        helpFullRef.current = false;
        setHelpRect(null);
        invoke("window_resized").catch(console.error);
      }
      scheduleHide();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [helpOpen]);

  // ---------- 布局（滚轮像素级回看，scrollPx=0 时最新卡片靠右） ----------
  const capacity = visibleCapacity(width, size);
  const visCount = Math.min(items.length, capacity);
  const maxScroll = Math.max(0, items.length - visCount);
  const sp = spacing(size);
  const maxScrollPx = maxScroll * sp;
  // 删卡片后 clamp；sc 为浮点"卡单位"，startFloat 连续移动可见窗口
  const sc = Math.min(scrollPx, maxScrollPx) / sp;
  const startFloat = maxScroll - sc;
  const start = Math.floor(startFloat);
  // 子格偏移：所有可见卡整体左移 frac 格；凑满一格时窗口切换，
  // 新卡才从折叠区挂进来（徽章数量与折叠同步变化）
  const shiftPx = (startFloat - start) * sp;
  const visibleItems = items
    .slice(start, start + visCount)
    .map((it, i) => ({ item: it, i }));
  const folded = items.slice(0, start);
  const foldedRight = items.slice(start + visCount);
  const halfSpan = ((visCount - 1) / 2) * spacing(size);
  // 左右折叠堆叠与可见区对称摆放（各留一格间距），
  // 并 clamp 到距屏幕边界 ≥ 20px（窄屏 / 半屏时不再贴边出屏）
  const FAN_EDGE = 20;
  const fanX = Math.max(
    FAN_EDGE + cardWidth(size) / 2,
    width / 2 - halfSpan - spacing(size) - 10
  );
  const fanXRight = Math.min(
    width - FAN_EDGE - cardWidth(size) / 2,
    width / 2 + halfSpan + spacing(size) + 10
  );
  const panelH = panelHeight(size);

  // ---------- 滚轮：像素级平滑回看（凑满一格卡片才从折叠区出来） ----------
  // 卡片上滚动（WebView 原生 wheel）与条带空白区滚动（panel-wheel 转发）共用
  const applyWheel = useCallback(
    (dy: number, dx: number) => {
      if (maxScroll <= 0) return;
      cancelHide();
      wheelAccRef.current += dy + dx;
      // 触控板小步事件累积到阈值才生效，避免高频抖动
      const TH = 24;
      if (Math.abs(wheelAccRef.current) < TH) return;
      const acc = wheelAccRef.current;
      wheelAccRef.current = 0;
      setScrollPx((s) => Math.max(0, Math.min(maxScrollPx, s + acc)));
    },
    [maxScroll, maxScrollPx, cancelHide]
  );

  // 条带区域内（含空白穿透区）滚轮：Rust 鼠标钩子转发而来
  useEffect(() => {
    const un = listen<[number, number]>("panel-wheel", (e) => {
      if (!revealedRef.current) return;
      const [dx, dy] = e.payload;
      applyWheel(dy, dx);
    });
    return () => {
      un.then((f) => f());
    };
  }, [applyWheel]);

  const onWheel = (e: React.WheelEvent) => applyWheel(e.deltaY, e.deltaX);

  // ---------- 命中区上报 ----------
  useEffect(() => {
    if (helpRect) {
      // 弹窗打开：窗口已全屏化，只报弹窗矩形（留 16px hover 余量），
      // 其余区域穿透；panel_h=0 关闭"按住左键拖入"兜底与滚轮拦截，
      // 避免全屏窗口截获其他拖拽/滚动
      api
        .setHitRects(
          [[helpRect.x - 16, helpRect.y - 16, helpRect.w + 32, helpRect.h + 32]],
          0,
          false,
        )
        .catch(console.error);
      return;
    }
    const cw = cardWidth(size);
    const ph = photoMaxHeight(size);
    const rects: [number, number, number, number][] = [];
    if (revealed) {
      for (const v of visibleItems) {
        const cx = visibleX(v.i, visCount, width, size) - shiftPx;
        const y = ropeY(cx, width) - PIN_ABOVE;
        // 贴合卡片实际 DOM：衣夹 26px + 卡片约 ph+8，只留少量 hover 放大余量，
        // 避免吞掉卡片下方/两侧的鼠标事件（桌面内容保持正常 hover）
        rects.push([cx - cw / 2 - 3, y, cw + 6, 26 + ph + 18]);
      }
      if (folded.length > 0) {
        rects.push([fanX - (cw + 16) / 2, 18, cw + 16, ph + 66]);
      }
      if (foldedRight.length > 0) {
        rects.push([fanXRight - (cw + 16) / 2, 18, cw + 16, ph + 66]);
      }
      if (items.length === 0) {
        // 空绳装饰：中间夹着的小图
        const cx = width / 2;
        const py = ropeY(cx, width) - PIN_ABOVE;
        rects.push([cx - 55, py - 4, 110, 100]);
      }
    }
    api.setHitRects(rects, panelH, maxScroll > 0).catch(console.error);
  }, [items, width, size, revealed, menu, scrollPx, helpRect]);

  return (
    <div
      className={"panel" + (revealed ? "" : " hidden")}
      style={{ height: panelH }}
      onWheel={onWheel}
    >
      <Rope width={width} active={dragHover} />
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
      {/* 入场时序：左堆叠先于首卡浮现，右堆叠等所有卡片浮现完最后出现 */}
      <OverflowFan
        items={folded}
        x={fanX}
        size={size}
        revealDelay={REVEAL_BASE - 40}
      />
      <OverflowFan
        items={foldedRight}
        x={fanXRight}
        size={size}
        revealDelay={
          REVEAL_BASE + revealStagger(visCount - 1, visCount) + REVEAL_DUR
        }
      />
      {visibleItems.map(({ item, i }) => (
        <PeggedCard
          key={item.id}
          item={item}
          index={i}
          count={visCount}
          width={width}
          size={size}
          x={visibleX(i, visCount, width, size) - shiftPx}
          onContextMenu={openCardMenu}
          onRemove={(id) => removeItems([id])}
          falling={fallingIds.includes(item.id)}
        />
      ))}
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      {helpOpen && (
        <HelpDialog
          onRect={setHelpRect}
          onDragStart={() =>
            invoke("set_capture_override", { on: true }).catch(() => {})
          }
          onDragEnd={() =>
            // 菜单还开着则保持强制可交互，否则恢复命中区驱动
            invoke("set_capture_override", { on: !!menuRef.current }).catch(() => {})
          }
          onClose={() => setHelpOpen(false)}
        />
      )}
      {toast && <div className="toast glass-strong">{toast}</div>}
    </div>
  );
}
