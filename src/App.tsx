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
  dockScale,
  DOCK_MAX,
  DOCK_RANGE,
  panelHeight,
  photoMaxHeight,
  PIN_ABOVE,
  ROPE_TOP,
  ropeY,
  sag,
  SizeKey,
  spacing,
  visibleCapacity,
  visibleX,
} from "./layout";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "./theme";

let seq = 1;
const nextId = () => `i${seq++}`;

// 运行时平台判断：Windows 的彩虹渐变由 native-drop（OLE）驱动，macOS 由 Tauri 跨平台
// 拖放事件驱动。用 IS_MAC 把 onDragDropEvent 里的 dragHover 逻辑物理隔离到 macOS，
// 确保 Windows 行为完全不受影响（不引入原生插件，避免动 capabilities / 权限）。
const IS_MAC =
  typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent || "");

// 使用说明弹窗矩形（窗口逻辑坐标）。弹窗打开时窗口临时全屏化，
// 弹窗可全屏随意拖动；该矩形作为点击命中区上报（弹窗外保持穿透）
type HelpRect = { x: number; y: number; w: number; h: number };

export default function App() {
  // 跟踪系统（Windows / macOS）明暗主题，写入 <html data-theme> 驱动全部暗色样式
  useTheme();
  const [items, setItems] = useState<Item[]>([]);
  const [size, setSize] = useState<SizeKey>("small");
  const [revealed, setRevealed] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [helpOpen, setHelpOpen] = useState(false); // 使用说明弹窗（托盘菜单触发）
  const [helpRect, setHelpRect] = useState<HelpRect | null>(null); // 弹窗当前矩形（驱动命中区上报）
  const [width, setWidth] = useState(window.innerWidth);
  const [dragHover, setDragHover] = useState(false); // 外部拖拽悬停在可放置区（绳子彩色流动反馈）
  const [scrollPx, setScrollPx] = useState(0); // 滚轮回看偏移 px（0 = 最新卡片靠右）
  const [reorder, setReorder] = useState<{ id: string; mx: number } | null>(null); // 夹子拖拽重排：被拖卡片 id + 鼠标 x
  const reorderRef = useRef<{ id: string; mx: number } | null>(null);
  reorderRef.current = reorder;
  const wheelAccRef = useRef(0); // 滚轮累积量（触控板小步事件合并防抖）
  // ---------- Dock 放大联动（Rust 钩子转发条带内鼠标位置） ----------
  const panelRef = useRef<HTMLDivElement>(null);
  const mouseRef = useRef<number | null>(null); // 条带内鼠标逻辑 x（null = 离开，全部缩回）
  const slotsRef = useRef<{ el: HTMLElement; x: number }[]>([]); // 可见卡片 DOM + 中心 x
  const zoneBottomRef = useRef(0); // 卡片感应区底部 y（低于此不触发放大）
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef(0);
  // macOS 未授予「辅助功能 / 输入监控」权限时，精细点击穿透不可用，提示用户授权
  const [macDenied, setMacDenied] = useState(false);
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
  const HIDE_DELAY = 1000; // 移出晾衣绳区域 1s 后隐藏（win/mac 同路径）
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

  // macOS 授权入口：弹出系统授权框；授权成功后精细穿透即时生效
  const requestMacPermission = useCallback(() => {
    api
      .requestMacPermission()
      .then((ok) => {
        if (ok) {
          setMacDenied(false);
          showToast("已授权，点击穿透到下方窗口已启用");
        } else {
          showToast("请在系统设置中授权后重启晾衣绳生效");
        }
      })
      .catch(() => {});
  }, [showToast]);

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
    // macOS 未授权：提示开启精细点击穿透（点击/拖动微信等下方窗口不再被遮挡）
    const un9 = listen("mac-tap-denied", () => setMacDenied(true));
    // 鼠标进入 / 离开面板区域（驱动闲置隐藏）
    const un6 = listen<boolean>("panel-hover", (e) => {
      hoverRef.current = !!e.payload;
      if (hoverRef.current) {
        cancelHide();
        // 注意：这里不做 macOS 预激活。鼠标移入即激活会抢占正在使用的应用
        // （打字/游戏时被夺走键盘焦点）。改为真正的交互时才激活：
        // 点击（左/右键）→ panel 捕获阶段监听；滚动 → applyWheel；
        // 拖入 → drag-drop enter。拖出卡片不手动激活——acceptFirstMouse
        //（tauri.conf.json）让后台首击直达 WebView 并由系统激活，
        // 拖拽会话本身不要求前台（同 Tendedero 的做法）。
      } else {
        // 原生钩子已确认光标（含按住左键的文件拖拽）离开条带窗口。
        // OLE（Windows）/ NSDragging（macOS）的拖放 leave 事件可能在条带
        // 转回穿透态后丢失，dragHover 滞留 true 会挡住 scheduleHide，
        // 导致拖拽取消后绳子一直挂着——以钩子为准清掉再排定隐藏
        if (dragHoverRef.current) {
          dragHoverRef.current = false;
          setDragHover(false);
        }
        scheduleHide();
      }
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
        // macOS 没有 Windows 的 OLE 原生拖入事件（native-drop），
        // 彩虹流动反馈改由 Tauri 跨平台拖放事件驱动（仅 macOS）
        if (IS_MAC) {
          setDragHover(true);
          cancelHide();
          // 拖入文件 = 真正的拖拽交互，此刻激活（不早于交互抢占前台）
          api.activateApp().catch(() => {});
        }
      } else if (e.payload.type === "over") {
        if (!wiggleDone) {
          wiggleDone = true;
          window.dispatchEvent(new CustomEvent("rope-wiggle"));
        }
        if (IS_MAC) setDragHover(true);
      } else if (e.payload.type === "drop") {
        addPaths(e.payload.paths, "drag");
        if (IS_MAC) setDragHover(false);
        reveal();
      } else if (e.payload.type === "leave") {
        wiggleDone = false;
        if (IS_MAC) {
          setDragHover(false);
          // 直接清 ref（setState 异步渲染，scheduleHide 读到旧值会误判仍在拖拽）
          dragHoverRef.current = false;
          scheduleHide();
        }
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
          // 直接清 ref（setState 异步渲染，scheduleHide 读到旧值会误判仍在拖拽）
          dragHoverRef.current = false;
          scheduleHide();
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
      un9.then((f) => f());
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
    .map((it, i) => ({ item: it, i }));  const folded = items.slice(0, start);
  const foldedRight = items.slice(start + visCount);
  // 夹子拖拽重排用的最新布局参数（window 监听 handler 通过 ref 读取）
  const reorderLayoutRef = useRef({ sp, start, visCount, width, shiftPx });
  reorderLayoutRef.current = { sp, start, visCount, width, shiftPx };
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
      // 滚动是真实交互：macOS 此刻激活（-wheel 转发与 WebView 原生 wheel 都汇聚于此）。
      // 放在 maxScroll 早退前：卡片上滚动但无内容可滚（钩子仍拦截转发）也抢占
      if (IS_MAC && revealedRef.current) api.activateApp().catch(() => {});
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

  // ---------- 夹子拖拽重排（沿绳左右换位） ----------
  const startReorder = useCallback((e: React.PointerEvent, item: Item) => {
    setReorder({ id: item.id, mx: e.clientX });
    window.dispatchEvent(new CustomEvent("card-drag-start"));
  }, []);

  const endReorder = useCallback(() => {
    if (!reorderRef.current) return;
    setReorder(null);
    window.dispatchEvent(new CustomEvent("card-drag-end"));
  }, []);

  const moveReorder = useCallback((mx: number) => {
    const ro = reorderRef.current;
    if (!ro) return;
    const L = reorderLayoutRef.current;
    const count = Math.min(itemsRef.current.length, L.visCount);
    if (count > 0) {
      // 由鼠标 x 反解悬停的可见槽位，实时把被拖卡片移到该位置（其余卡片 CSS 过渡腾位）
      const hoverI = Math.round(
        (mx - L.width / 2 + L.shiftPx) / L.sp + (count - 1) / 2,
      );
      const clamped = Math.max(0, Math.min(count - 1, hoverI));
      const target = L.start + clamped;
      setItems((prev) => {
        const idx = prev.findIndex((it) => it.id === ro.id);
        if (idx < 0 || target === idx || target >= prev.length) return prev;
        const next = prev.slice();
        const [moved] = next.splice(idx, 1);
        next.splice(target, 0, moved);
        return next;
      });
    }
    setReorder((prev) =>
      prev && prev.mx !== mx ? { ...prev, mx } : prev,
    );
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!reorderRef.current) return;
      // 条带外松开左键收不到 pointerup：以 buttons 位兜底结束
      if ((e.buttons & 1) === 0) {
        endReorder();
        return;
      }
      moveReorder(e.clientX);
    };
    const onUp = () => endReorder();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [moveReorder, endReorder]);

  // ---------- 命中区上报 ----------
  useEffect(() => {
    const cw = cardWidth(size);
    const ph = photoMaxHeight(size);
    const rects: [number, number, number, number][] = [];
    if (revealed) {
      // 命中区必须覆盖卡片的「最大可见轮廓」：Dock 放大（以挂点为原点 ×DOCK_MAX）
      // + 风中摆动的外扩 + 少量接近余量。按静止原始尺寸算的话，鼠标压在放大/摆动
      // 出来的卡片边缘上会被判为卡片外，事件就穿透到下面的窗口去了。
      // 卡片区之外仍保持穿透（条带空白不吞鼠标）。
      const cardW = cw * DOCK_MAX + 16;
      const cardH = (26 + ph + 18) * DOCK_MAX + 14;
      for (const v of visibleItems) {
        const cx = visibleX(v.i, visCount, width, size) - shiftPx;
        const y = ropeY(cx, width) - PIN_ABOVE;
        rects.push([cx - cardW / 2, y - 4, cardW, cardH]);
      }
      if (folded.length > 0) {
        rects.push([fanX - (cw + 16) / 2, 14, cw + 16, ph + 70]);
      }
      if (foldedRight.length > 0) {
        rects.push([fanXRight - (cw + 16) / 2, 14, cw + 16, ph + 70]);
      }
      if (items.length === 0) {
        // 空绳装饰：中间夹着的小图
        const cx = width / 2;
        const py = ropeY(cx, width) - PIN_ABOVE;
        rects.push([cx - 55, py - 4, 110, 100]);
      }
    }
    if (helpRect) {
      // 弹窗打开：窗口已全屏化（逻辑坐标=屏幕坐标），弹窗矩形（留 16px
      // hover 余量）与卡片命中区合并上报，阅读说明期间卡片仍可点击 /
      // 悬停放大 / 滚轮回看 / 拖入挂绳，其余区域照常穿透
      rects.unshift([
        helpRect.x - 16,
        helpRect.y - 16,
        helpRect.w + 32,
        helpRect.h + 32,
      ]);
    }
    api.setHitRects(rects, panelH, maxScroll > 0).catch(console.error);
  }, [items, width, size, revealed, menu, scrollPx, helpRect]);

  // ---------- Dock 放大联动（macOS Dock 风格） ----------
  // Rust 鼠标钩子转发条带内光标位置（卡片间隙穿透，WebView 自身收不到 move），
  // 按每张卡片中心与鼠标 x 的距离算放大倍数，直接写 CSS 变量驱动，不走 React 渲染
  const applyDock = useCallback(() => {
    const mx = mouseRef.current;
    const sp = spacing(size);
    const range = DOCK_RANGE * sp;
    for (const s of slotsRef.current) {
      const d = mx == null ? Infinity : Math.abs(s.x - mx);
      // 超出影响范围清除变量（回落到 CSS 默认值 1，transition 平滑缩回）
      if (d >= range) s.el.style.removeProperty("--dock");
      else s.el.style.setProperty("--dock", dockScale(d, sp).toFixed(4));
    }
  }, [size]);

  // 布局变化（增删卡片 / 滚轮回看 / 尺寸档位 / 显示隐藏）后重建卡片索引
  useEffect(() => {
    if (!revealed) mouseRef.current = null; // 面板隐藏时清状态，下次唤出从原始大小开始
    // 感应区底部：卡片区（含衣夹）下沿 + 14px 余量；低于此不触发（条带下半空白区）
    zoneBottomRef.current =
      ROPE_TOP + sag(width) - PIN_ABOVE + 26 + photoMaxHeight(size) + 14;
    const panel = panelRef.current;
    if (!panel) return;
    slotsRef.current = Array.from(
      panel.querySelectorAll<HTMLElement>(".pegged-slot"),
    ).map((el) => ({ el, x: parseFloat(el.dataset.x || "0") }));
    applyDock();
  }, [items, width, size, scrollPx, revealed, applyDock]);

  useEffect(() => {
    const un = listen<[number, number] | null>("panel-mouse", (e) => {
      const p = e.payload;
      mouseRef.current = p && p[1] <= zoneBottomRef.current ? p[0] : null;
      applyDock();
    });
    return () => {
      un.then((f) => f());
    };
  }, [applyDock]);

  return (
    <div
      ref={panelRef}
      className={"panel" + (revealed ? "" : " hidden")}
      style={{ height: panelH }}
      onWheel={onWheel}
      // macOS 交互时激活：捕获阶段最先执行，覆盖 panel 内全部子元素——
      // 左键（卡片单击/双击/拖出、夹子重排、关闭按钮、弹窗拖动）与
      // 右键（contextmenu，含右键按下产生的 pointerdown button=2）。
      // 仅在已唤出时激活，未唤出（闲置态）不抢前台焦点
      onPointerDownCapture={() => {
        if (IS_MAC && revealedRef.current) api.activateApp().catch(() => {});
      }}
      onContextMenuCapture={() => {
        if (IS_MAC && revealedRef.current) api.activateApp().catch(() => {});
      }}
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
      <OverflowFan items={folded} x={fanX} size={size} />
      <OverflowFan items={foldedRight} x={fanXRight} size={size} />
      {visibleItems.map(({ item, i }) => {
        const isReorder = item.id === reorder?.id;
        const slotX = visibleX(i, visCount, width, size) - shiftPx;
        // 被拖卡片直接跟随鼠标（钳制在首末槽位之间，其余卡片已实时重排腾位）
        const x =
          isReorder && reorder
            ? Math.max(
                visibleX(0, visCount, width, size) - shiftPx,
                Math.min(
                  visibleX(visCount - 1, visCount, width, size) - shiftPx,
                  reorder.mx,
                ),
              )
            : slotX;
        return (
          <PeggedCard
            key={item.id}
            item={item}
            width={width}
            size={size}
            x={x}
            reorder={isReorder}
            onPinDown={startReorder}
            onContextMenu={openCardMenu}
            onRemove={(id) => removeItems([id])}
            falling={fallingIds.includes(item.id)}
          />
        );
      })}
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
      {macDenied && (
        <div className="perm-notice glass-strong">
          <span className="perm-text">
            为支持点击穿透到下方窗口（如微信），请在系统设置 → 隐私与安全性 →
            输入监控 / 辅助功能 中授权「晾衣绳」
          </span>
          <button className="perm-btn" onClick={requestMacPermission}>
            去授权
          </button>
          <button className="perm-btn ghost" onClick={() => setMacDenied(false)}>
            忽略
          </button>
        </div>
      )}
    </div>
  );
}
