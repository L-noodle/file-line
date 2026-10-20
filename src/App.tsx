import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, LogicalSize, currentMonitor } from "@tauri-apps/api/window";
import { confirm, open as openDialog } from "@tauri-apps/plugin-dialog";
import Rope from "./components/Rope";
import PeggedCard from "./components/PeggedCard";
import NoteCard from "./components/NoteCard";
import TodoCard from "./components/TodoCard";
import NoteEditor from "./components/NoteEditor";
import TodoEditor from "./components/TodoEditor";
import TodoDetail from "./components/TodoDetail";
import TodoReminder from "./components/TodoReminder";
import CountdownEditor from "./components/CountdownEditor";
import CountdownCard from "./components/CountdownCard";
import Notebook from "./components/Notebook";
import EntryCard from "./components/EntryCard";
import OverflowFan from "./components/OverflowFan";
import ContextMenu, { MenuState } from "./components/ContextMenu";
import HelpDialog from "./components/HelpDialog";
import type { Rect } from "./components/WindowDialog";
import { emptyTodoDraft, todoDraftOf, type TodoDraft } from "./components/TodoFields";
import {
  emptyCountdownDraft,
  countdownDraftOf,
  type CountdownDraft,
} from "./components/CountdownFields";
import type { Item, Note, Todo, Countdown } from "./types";
import { api } from "./api";
import type { NoteFile } from "./api";
import {
  cardWidth,
  DOCK_MAX,
  entryCardHeight,
  entryCardWidth,
  NAME_SECOND_LINE,
  noteCardHeight,
  noteCardWidth,
  countdownCardHeight,
  countdownCardWidth,
  panelHeight,
  photoMaxHeight,
  PIN_ABOVE,
  pitchBetween,
  ROPE_TOP,
  ropeY,
  sag,
  SizeKey,
  spacing,
  todoCardHeight,
  todoCardWidth,
  visibleCapacity,
  visibleCenters,
  WIDE_DOCK_MAX,
} from "./layout";
import { invoke } from "@tauri-apps/api/core";
import { useTheme } from "./theme";
import { setReordering } from "./reorderGuard";

let seq = 1;
const nextId = () => `i${seq++}`;
let noteSeq = 1;
const nextNoteId = () => `n${Date.now().toString(36)}-${noteSeq++}`;
let todoSeq = 1;
const nextTodoId = () => `t${Date.now().toString(36)}-${todoSeq++}`;
let countdownSeq = 1;
const nextCountdownId = () => `cd${Date.now().toString(36)}-${countdownSeq++}`;

// ---------- 待办提醒调度 ----------
type ReminderKind = "start" | "end";
type ReminderTarget = { todoId: string; kind: ReminderKind };

/** 提醒的触发时间戳：重复待办按「每天同一时间」取下一次发生 */
function occurrenceAt(t: Todo, kind: ReminderKind): number {
  const base = kind === "start" ? t.startAt : t.endAt;
  if (!base) return 0;
  if (!t.repeat) return base;
  const d = new Date(base);
  const now = new Date();
  const occ = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    d.getHours(),
    d.getMinutes(),
    0,
    0
  );
  if (occ.getTime() <= Date.now()) occ.setDate(occ.getDate() + 1);
  return occ.getTime();
}

// 便笺管理入口卡片：常驻绳尾（最右）的虚拟卡片——不落盘、不可移除 / 拖动 / 右键。
// 空绳时它是唯一一张（居中）；有卡片时永远在最右，滚轮回看折叠时随堆叠一起收起
const ENTRY_INDEX = 1_000_000; // 仅表示"永远排在最后"；z 序另用 entryZ 动态计算
const entryItem: Item = {
  id: "entry",
  path: "",
  name: "便笺管理",
  kind: "entry",
  tilt: (Math.random() * 2 - 1) * 2.5,
  index: ENTRY_INDEX,
  source: "clip",
};

/** 另存为的便笺文件名：正文（去首尾空格）前 10 字 + 下划线 + 序号 */
function noteFileName(text: string, index: number): string {
  const head = text.trim().slice(0, 10);
  return `${head || "便笺"}_${index}`;
}

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
  // 隐藏晾衣绳上的特殊入口卡片（便笺管理入口），托盘菜单勾选后生效并持久化
  const [hideEntry, setHideEntry] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [helpOpen, setHelpOpen] = useState(false); // 使用说明弹窗（托盘菜单触发）
  const [helpRect, setHelpRect] = useState<HelpRect | null>(null); // 弹窗当前矩形（驱动命中区上报）
  // ---------- 便笺 / 笔记本 ----------
  const [notes, setNotes] = useState<Note[]>([]); // 笔记本数据（卡片取下不影响）
  const notesRef = useRef<Note[]>([]);
  notesRef.current = notes;
  // ---------- 待办 ----------
  const [todos, setTodos] = useState<Todo[]>([]);
  const todosRef = useRef<Todo[]>([]);
  todosRef.current = todos;
  // ---------- 倒计时 ----------
  const [countdowns, setCountdowns] = useState<Countdown[]>([]);
  const countdownsRef = useRef<Countdown[]>([]);
  countdownsRef.current = countdowns;
  // 倒计时编辑弹窗（可同时开多个；同一倒计时只开一个，重复触发就是置顶）
  const [countdownEditors, setCountdownEditors] = useState<
    { countdownId: string; cardId: string; draft: CountdownDraft; creating: boolean }[]
  >([]);
  const countdownEditorsRef = useRef(countdownEditors);
  countdownEditorsRef.current = countdownEditors;
  // 待办编辑弹窗（可同时开多个；同一待办只开一个，重复触发就是置顶）
  const [todoEditors, setTodoEditors] = useState<
    { todoId: string; cardId: string; draft: TodoDraft; creating: boolean }[]
  >([]);
  const todoEditorsRef = useRef(todoEditors);
  todoEditorsRef.current = todoEditors;
  const [todoDetailId, setTodoDetailId] = useState<string | null>(null);
  // ---------- 待办提醒 ----------
  const [reminder, setReminder] = useState<ReminderTarget | null>(null);
  const [reminderRect, setReminderRect] = useState<Rect | null>(null);
  const [snoozes, setSnoozes] = useState<
    { todoId: string; kind: ReminderKind; at: number }[]
  >([]);
  const snoozesRef = useRef(snoozes);
  snoozesRef.current = snoozes;
  const [snoozeMin, setSnoozeMin] = useState(5);
  const firedRef = useRef<Set<string>>(new Set()); // 已触发过的提醒（本次运行期）
  // 便笺编辑弹窗（可同时开多个；同一便笺只开一个，重复触发就是置顶）
  // creating = 本次是新建（空内容提交则丢弃）
  const [editors, setEditors] = useState<
    { noteId: string; cardId: string; text: string; creating: boolean }[]
  >([]);
  const editorsRef = useRef(editors);
  editorsRef.current = editors;
  const [notebookOpen, setNotebookOpen] = useState(false);
  // 弹窗层级：key → 序号，点谁谁 +1 置顶（各弹窗独立层级）
  const zRef = useRef(0);
  const [zMap, setZMap] = useState<Record<string, number>>({});
  const bringToFront = useCallback((key: string) => {
    zRef.current += 1;
    const v = zRef.current;
    setZMap((prev) => ({ ...prev, [key]: v }));
  }, []);
  const editorKey = (noteId: string) => `editor:${noteId}`;
  const todoEditorKey = (todoId: string) => `todo-editor:${todoId}`;
  const countdownEditorKey = (countdownId: string) => `countdown-editor:${countdownId}`;
  const TODO_DETAIL_KEY = "todo-detail";
  const NOTEBOOK_KEY = "notebook";
  // 便笺 / 笔记本弹窗矩形（按 id 分开存，两个弹窗可同时打开）
  const [dlgRects, setDlgRects] = useState<Record<string, Rect>>({});
  const reportRect = useCallback((id: string, r: Rect | null) => {
    setDlgRects((prev) => {
      if (!r) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      const p = prev[id];
      if (p && p.x === r.x && p.y === r.y && p.w === r.w && p.h === r.h)
        return prev;
      return { ...prev, [id]: r };
    });
  }, []);
  const editorRectFor = useCallback(
    (noteId: string) => (r: Rect | null) => reportRect(editorKey(noteId), r),
    [reportRect]
  );
  const notebookRect = useCallback(
    (r: Rect | null) => reportRect(NOTEBOOK_KEY, r),
    [reportRect]
  );
  const todoDetailRect = useCallback(
    (r: Rect | null) => reportRect(TODO_DETAIL_KEY, r),
    [reportRect]
  );
  const reminderRectFor = useCallback(
    (r: Rect | null) => setReminderRect(r),
    []
  );
  const loadedRef = useRef(false); // 初始状态读完前不回写，避免覆盖持久化数据
  const [width, setWidth] = useState(window.innerWidth);
  const [dragHover, setDragHover] = useState(false); // 外部拖拽悬停在可放置区（绳子彩色流动反馈）
  const [scrollPx, setScrollPx] = useState(0); // 滚轮回看偏移 px（0 = 最新卡片靠右）
  const [reorder, setReorder] = useState<{ id: string; mx: number } | null>(null); // 夹子拖拽重排：被拖卡片 id + 鼠标 x
  const reorderRef = useRef<{ id: string; mx: number } | null>(null);
  reorderRef.current = reorder;
  const wheelAccRef = useRef(0); // 滚轮累积量（触控板小步事件合并防抖）
  // ---------- 卡片悬停放大（Rust 钩子转发条带内鼠标位置） ----------
  const panelRef = useRef<HTMLDivElement>(null);
  const mouseRef = useRef<number | null>(null); // 条带内鼠标逻辑 x（null = 离开，全部缩回）
  const mouseYRef = useRef<number | null>(null); // 条带内鼠标逻辑 y（穿透态悬停判定用）
  const slotsRef = useRef<{ el: HTMLElement; x: number; w: number }[]>([]); // 可见卡片 DOM + 中心 x + 宽
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
  // 当前为菜单把窗口加高到的逻辑高度（0 = 窗口仍在条带原始高度）。
  // 记录「我们下发过的目标高度」而不是读 window.innerHeight：窗口尺寸是
  // 异步生效的，连续右键时读到的是上一次加高后的旧值
  const menuHRef = useRef(0);
  // 菜单关闭后恢复条带高度的延时器（连续右键时会被下一次开菜单取消）
  const menuRestoreTimer = useRef(0);
  // 已下发但还没完成的恢复 IPC（下次加高要排在它后面）
  const menuRestoreP = useRef<Promise<unknown> | null>(null);
  // 弹窗（使用说明 / 便笺 / 笔记本）打开期间窗口是否被临时全屏化
  const modalFullRef = useRef(false);
  // 任一弹窗打开：不自动收起绳子（弹窗期间窗口已全屏化）
  const anyModal =
    helpOpen ||
    editors.length > 0 ||
    todoEditors.length > 0 ||
    countdownEditors.length > 0 ||
    todoDetailId != null ||
    notebookOpen;
  const anyModalRef = useRef(false);
  anyModalRef.current = anyModal;

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

  // 提醒消息是否还在展示（绳子收起时窗口不能藏——消息要继续显示）
  const reminderRef = useRef(false);
  reminderRef.current = !!reminder;

  const hideNow = useCallback(() => {
    if (!revealedRef.current) return;
    cancelHide();
    setRevealed(false);
    setHelpOpen(false); // 收起绳子时一并关闭使用说明弹窗
    // 等滑出动画结束后隐藏窗口
    animTimer.current = window.setTimeout(() => {
      if (revealedRef.current) return; // 期间又被唤起
      // 提醒还在展示：只收起绳子（复位顶部触发），窗口保持全屏
      // 显示（消息可继续点/拖/稍后/关闭）
      if (reminderRef.current) {
        api.collapseRopeKeepWindow().catch(console.error);
        return;
      }
      api.hideRope().catch(console.error);
    }, ANIM_MS);
  }, [cancelHide]);

  const scheduleHide = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    if (!revealedRef.current) return;
    if (
      hoverRef.current ||
      dragActiveRef.current ||
      dragHoverRef.current ||
      menuRef.current ||
      helpOpenRef.current ||
      anyModalRef.current
    )
      return;
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

  // ---------- 待办提醒 ----------
  /** 到点弹出提醒消息：此时不展示拖拽绳子，只展示消息本身 */
  const fireReminder = useCallback(
    (t: ReminderTarget) => {
      setReminder(t);
      setSnoozeMin(5);
      cancelHide();
      // 绳子未唤出：只把窗口显示出来（不唤出绳子），消息独立展示。
      // 窗口临时全屏化（同弹窗 anyModal 的处理）：条带窗口太矮，消息
      // 在顶部 40px 处会被截断；全屏后逻辑坐标=屏幕坐标，消息还能拖
      (async () => {
        const mon = await currentMonitor();
        const win = getCurrentWindow();
        if (mon) {
          await win.setPosition(mon.position);
          await win.setSize(mon.size);
        }
      })().catch(console.error);
      if (!revealedRef.current) api.showReminderWindow().catch(console.error);
    },
    [cancelHide]
  );

  /** 关闭提醒：绳子本来没收起的话，把窗口藏回去（保持只展示消息本身） */
  const closeReminder = useCallback(() => {
    setReminder(null);
    setSnoozes([]);
    if (!revealedRef.current) {
      // 绳子未唤出：隐藏窗口（hide_rope 内部会先缩回条带高度）
      api.hideRope().catch(console.error);
    }
    // 绳子已唤出：窗口保持全屏（收绳流程 hideNow / collapse 分支处理）
  }, []);

  /** 稍后 N 分钟再次提醒（N 可改，且换算后的时刻不超过结束时间） */
  const snoozeReminder = useCallback(
    (target: ReminderTarget, minutes: number) => {
      const t = todosRef.current.find((x) => x.id === target.todoId);
      let at = Date.now() + Math.max(1, minutes) * 60000;
      if (t?.endAt && at > t.endAt) at = Math.max(Date.now() + 60000, t.endAt);
      setSnoozes((prev) => [
        ...prev.filter(
          (s) => !(s.todoId === target.todoId && s.kind === target.kind)
        ),
        { todoId: target.todoId, kind: target.kind, at },
      ]);
      closeReminder();
    },
    [closeReminder]
  );

  // 提醒调度：每 15s 检查一次（稍后提醒到点重弹 + 开始前 / 结束前定时提醒）
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      // 稍后提醒：到点再弹一次
      const due = snoozesRef.current.filter((s) => s.at <= now);
      if (due.length > 0) {
        fireReminder(due[0]);
        setSnoozes((prev) => [
          ...prev.filter((s) => s.at > now),
          ...due.slice(1),
        ]);
      }
      // 定时提醒：开始前 / 结束前 N 分钟（每次运行期只弹一次）
      for (const t of todosRef.current) {
        if (t.done) continue;
        for (const kind of ["start", "end"] as const) {
          const offset = kind === "start" ? t.remindStart : t.remindEnd;
          if (offset == null) continue;
          const occ = occurrenceAt(t, kind);
          if (!occ) continue;
          const fireAt = occ - offset * 60000;
          if (fireAt <= 0 || fireAt > now) continue;
          const key = `${t.id}:${kind}:${fireAt}`;
          if (firedRef.current.has(key)) continue;
          firedRef.current.add(key);
          fireReminder({ todoId: t.id, kind });
          return; // 一次只弹一个
        }
      }
    };
    const timer = window.setInterval(tick, 15000);
    return () => window.clearInterval(timer);
  }, [fireReminder]);

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
        // 入口卡片隐藏开关（托盘菜单「隐藏入口卡片」）
        setHideEntry(!!st.hideEntryCards);
        // 便笺先于卡片载入：便笺卡片要用便笺正文渲染
        const loaded: Note[] = Array.isArray(st.notes)
          ? st.notes.map((n) => ({
              id: n.id,
              text: n.text ?? "",
              updatedAt: n.updatedAt ?? 0,
              createdAt: n.createdAt ?? n.updatedAt ?? 0,
              pinned: !!n.pinned,
            }))
          : [];
        setNotes(loaded);
        notesRef.current = loaded;
        // 待办同样先于卡片载入
        const loadedTodos: Todo[] = Array.isArray(st.todos)
          ? st.todos.map((t) => ({
              id: t.id,
              title: t.title ?? "",
              text: t.text ?? "",
              startAt: t.startAt ?? 0,
              endAt: t.endAt ?? 0,
              repeat: !!t.repeat,
              remindStart: t.remindStart ?? null,
              remindEnd: t.remindEnd ?? null,
              done: !!t.done,
              updatedAt: t.updatedAt ?? 0,
              createdAt: t.createdAt ?? t.updatedAt ?? 0,
              pinned: !!t.pinned,
            }))
          : [];
        setTodos(loadedTodos);
        todosRef.current = loadedTodos;
        // 倒计时同样先于卡片载入
        const loadedCountdowns: Countdown[] = Array.isArray(st.countdowns)
          ? st.countdowns.map((c) => ({
              id: c.id,
              title: c.title ?? "",
              text: c.text ?? "",
              endAt: c.endAt ?? 0,
              updatedAt: c.updatedAt ?? 0,
              createdAt: c.createdAt ?? c.updatedAt ?? 0,
              pinned: !!c.pinned,
            }))
          : [];
        setCountdowns(loadedCountdowns);
        countdownsRef.current = loadedCountdowns;
        if (Array.isArray(st.items)) {
          for (const it of st.items) {
            // 兼容落盘形态：便笺 / 待办 / 倒计时卡片只有 id，文件卡片有 path
            const it0 = it as {
              path?: string;
              source?: string;
              noteId?: string;
              todoId?: string;
              countdownId?: string;
            };
            if (it0.noteId) {
              const n = loaded.find((x) => x.id === it0.noteId);
              addNoteCard(it0.noteId, n?.text ?? "");
            } else if (it0.todoId) {
              const t = loadedTodos.find((x) => x.id === it0.todoId);
              addTodoCard(it0.todoId, t?.title ?? "");
            } else if (it0.countdownId) {
              const c = loadedCountdowns.find((x) => x.id === it0.countdownId);
              addCountdownCard(it0.countdownId, c?.title ?? "");
            } else if (typeof it0.path === "string" && it0.path) {
              await addItem(it0.path, it0.source === "drag" ? "drag" : "clip");
            }
          }
        }
      } catch (e) {
        console.error(e);
      } finally {
        loadedRef.current = true;
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
    // 托盘菜单「新增便笺」：新建便笺（挂卡片 + 编辑窗），绳子未唤出则先唤出
    const un10 = listen("tray-new-note", () => {
      createNote();
    });
    // 托盘菜单「新增待办」：新建待办（挂卡片 + 编辑窗）
    const un12 = listen("tray-new-todo", () => {
      createTodo();
    });
    // 托盘菜单「新增倒计时」：新建倒计时（挂卡片 + 编辑窗）
    const un13 = listen("tray-new-countdown", () => {
      createCountdown();
    });
    // 托盘菜单「打开笔记本」：唤出绳子并打开便笺管理器
    const un11 = listen("tray-open-notebook", () => {
      reveal();
      bringToFront(NOTEBOOK_KEY);
      setNotebookOpen(true);
    });
    // 托盘菜单「隐藏入口卡片」：勾选/取消勾选即时收起/恢复绳尾入口卡片。
    // 绳子通常正处于收起态（否则不会去点托盘），先唤出让效果当场可见
    const un14 = listen<boolean>("hide-entry-cards", (e) => {
      const on = !!e.payload;
      setHideEntry(on);
      reveal();
      showToast(on ? "已隐藏入口卡片" : "已恢复入口卡片");
    });
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
      un10.then((f) => f());
      un11.then((f) => f());
      un12.then((f) => f());
      un13.then((f) => f());
      un14.then((f) => f());
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
  /** 把便笺挂到绳子上（笔记本里可重复挂起，同一便笺可有多张卡片） */
  const addNoteCard = useCallback((noteId: string, text: string) => {
    const item: Item = {
      id: nextId(),
      path: "",
      name: "便笺",
      kind: "note",
      tilt: (Math.random() * 2 - 1) * 2.5,
      index: seq,
      source: "clip",
      noteId,
      text,
    };
    setItems((prev) => [...prev, item]);
    // 新卡片进绳：回到最右端（最新）
    setScrollPx(0);
    return item;
  }, []);

  /** 新建便笺（返回 id，便于笔记本立即选中） */
  const newNote = useCallback(() => {
    const now = Date.now();
    const note: Note = { id: nextNoteId(), text: "", updatedAt: now, createdAt: now };
    setNotes((prev) => [note, ...prev]);
    notesRef.current = [note, ...notesRef.current];
    return note.id;
  }, []);

  /** 把待办挂到绳子上（笔记本里可重复挂起，同一待办可有多张卡片） */
  const addTodoCard = useCallback((todoId: string, title: string) => {
    const item: Item = {
      id: nextId(),
      path: "",
      name: title || "待办",
      kind: "todo",
      tilt: (Math.random() * 2 - 1) * 2.5,
      index: seq,
      source: "clip",
      todoId,
    };
    setItems((prev) => [...prev, item]);
    // 新卡片进绳：回到最右端（最新）
    setScrollPx(0);
    return item;
  }, []);

  /** 新建待办（返回 id，便于笔记本立即选中） */
  const newTodo = useCallback(() => {
    const now = Date.now();
    const todo: Todo = {
      id: nextTodoId(),
      title: "",
      text: "",
      startAt: 0,
      endAt: 0,
      repeat: false,
      remindStart: null,
      remindEnd: null,
      done: false,
      updatedAt: now,
      createdAt: now,
    };
    setTodos((prev) => [todo, ...prev]);
    todosRef.current = [todo, ...todosRef.current];
    return todo.id;
  }, []);

  /** 把倒计时挂到绳子上（笔记本里可重复挂起，同一倒计时可有多张卡片） */
  const addCountdownCard = useCallback((countdownId: string, title: string) => {
    const item: Item = {
      id: nextId(),
      path: "",
      name: title || "倒计时",
      kind: "countdown",
      tilt: (Math.random() * 2 - 1) * 2.5,
      index: seq,
      source: "clip",
      countdownId,
    };
    setItems((prev) => [...prev, item]);
    // 新卡片进绳：回到最右端（最新）
    setScrollPx(0);
    return item;
  }, []);

  /** 新建倒计时（返回 id，便于笔记本立即选中） */
  const newCountdown = useCallback(() => {
    const now = Date.now();
    const c: Countdown = {
      id: nextCountdownId(),
      title: "",
      text: "",
      endAt: 0,
      updatedAt: now,
      createdAt: now,
    };
    setCountdowns((prev) => [c, ...prev]);
    countdownsRef.current = [c, ...countdownsRef.current];
    return c.id;
  }, []);

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

  // ---------- 取下卡片（掉落动画） ----------
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

  // ---------- 便笺 ----------
  /** 打开便笺编辑窗：同一便笺已开着就只置顶，不重复开窗 */
  const openNoteEditor = useCallback(
    (noteId: string, cardId: string, text: string, creating: boolean) => {
      cancelHide();
      bringToFront(editorKey(noteId));
      setEditors((prev) =>
        prev.some((e) => e.noteId === noteId)
          ? prev
          : [...prev, { noteId, cardId, text, creating }]
      );
    },
    [bringToFront, cancelHide]
  );

  /** 新建便笺：先在笔记本里建一条，再挂一张卡片到绳上，同时弹出编辑窗 */
  const createNote = useCallback(() => {
    cancelHide();
    const id = newNote();
    const item = addNoteCard(id, "");
    reveal();
    openNoteEditor(id, item.id, "", true);
    return id;
  }, [addNoteCard, cancelHide, newNote, openNoteEditor, reveal]);

  /** 打开待办编辑窗：同一待办已开着就只置顶，不重复开窗 */
  const openTodoEditor = useCallback(
    (todoId: string, cardId: string, draft: TodoDraft, creating: boolean) => {
      cancelHide();
      bringToFront(todoEditorKey(todoId));
      setTodoEditors((prev) =>
        prev.some((e) => e.todoId === todoId)
          ? prev
          : [...prev, { todoId, cardId, draft, creating }]
      );
    },
    [bringToFront, cancelHide]
  );

  /** 新建待办：先建一条，再挂一张卡片到绳上，同时弹出编辑窗 */
  const createTodo = useCallback(() => {
    cancelHide();
    const id = newTodo();
    const item = addTodoCard(id, "");
    reveal();
    openTodoEditor(id, item.id, emptyTodoDraft(), true);
    return id;
  }, [addTodoCard, cancelHide, newTodo, openTodoEditor, reveal]);

  /** 双击待办卡片 / 菜单「编辑待办」/ 详情弹窗「编辑」：打开编辑窗 */
  const editTodoCard = useCallback(
    (todoId: string) => {
      const t = todosRef.current.find((x) => x.id === todoId);
      if (!t) return;
      setTodoDetailId(null);
      openTodoEditor(t.id, "", todoDraftOf(t), false);
    },
    [openTodoEditor]
  );

  /** 打开倒计时编辑窗：同一倒计时已开着就只置顶，不重复开窗 */
  const openCountdownEditor = useCallback(
    (countdownId: string, cardId: string, draft: CountdownDraft, creating: boolean) => {
      cancelHide();
      bringToFront(countdownEditorKey(countdownId));
      setCountdownEditors((prev) =>
        prev.some((e) => e.countdownId === countdownId)
          ? prev
          : [...prev, { countdownId, cardId, draft, creating }]
      );
    },
    [bringToFront, cancelHide]
  );

  /** 新建倒计时：先建一条，再挂一张卡片到绳上，同时弹出编辑窗 */
  const createCountdown = useCallback(() => {
    cancelHide();
    const id = newCountdown();
    const item = addCountdownCard(id, "");
    reveal();
    openCountdownEditor(id, item.id, emptyCountdownDraft(), true);
    return id;
  }, [addCountdownCard, cancelHide, newCountdown, openCountdownEditor, reveal]);

  /** 双击倒计时卡片 / 菜单「编辑倒计时」：打开编辑窗 */
  const editCountdownCard = useCallback(
    (countdownId: string) => {
      const c = countdownsRef.current.find((x) => x.id === countdownId);
      if (!c) return;
      openCountdownEditor(c.id, "", countdownDraftOf(c), false);
    },
    [openCountdownEditor]
  );

  /** 双击便笺卡片 / 菜单「编辑便笺」：打开编辑窗 */
  const editNoteCard = useCallback(
    (item: Item) => {
      if (!item.noteId) return;
      openNoteEditor(item.noteId, item.id, item.text ?? "", false);
    },
    [openNoteEditor]
  );

  /** 打勾：正文写回便笺与绳上所有引用它的卡片 */
  const submitNote = useCallback(
    (noteId: string, text: string) => {
      const ed = editorsRef.current.find((e) => e.noteId === noteId);
      setEditors((prev) => prev.filter((e) => e.noteId !== noteId));
      if (!ed) return;
      if (!text.trim() && ed.creating) {
        // 新建却没写内容：连卡片带便笺一起丢弃，不留垃圾
        removeItems([ed.cardId]);
        setNotes((prev) => prev.filter((n) => n.id !== ed.noteId));
        return;
      }
      setNotes((prev) =>
        prev.map((n) =>
          n.id === ed.noteId ? { ...n, text, updatedAt: Date.now() } : n
        )
      );
      setItems((prev) =>
        prev.map((i) => (i.noteId === ed.noteId ? { ...i, text } : i))
      );
    },
    [removeItems]
  );

  /** 关闭编辑窗：新建且一个字没写 → 连卡片带便笺丢弃，不留空壳 */
  const closeEditor = useCallback(
    (noteId: string, text: string) => {
      const ed = editorsRef.current.find((e) => e.noteId === noteId);
      setEditors((prev) => prev.filter((e) => e.noteId !== noteId));
      if (ed?.creating && !text.trim()) {
        removeItems([ed.cardId]);
        setNotes((prev) => prev.filter((n) => n.id !== ed.noteId));
      }
    },
    [removeItems]
  );

  /** 笔记本右侧直接编辑：实时写回便笺与绳上卡片 */
  const editNoteText = useCallback((noteId: string, text: string) => {
    setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, text } : n)));
    setItems((prev) =>
      prev.map((i) => (i.noteId === noteId ? { ...i, text } : i))
    );
  }, []);

  /** 编辑结束（失焦）：刷新修改时间 */
  const touchNote = useCallback((noteId: string) => {
    setNotes((prev) =>
      prev.map((n) =>
        n.id === noteId ? { ...n, updatedAt: Date.now() } : n
      )
    );
  }, []);

  /** 置顶 / 取消置顶 */
  const togglePin = useCallback((noteId: string) => {
    setNotes((prev) =>
      prev.map((n) => (n.id === noteId ? { ...n, pinned: !n.pinned } : n))
    );
  }, []);

  /** 笔记本里拖拽排序：把该便笺插到展示顺序的第 index 位（只允许在同组内移动） */
  const reorderNote = useCallback((noteId: string, target: number) => {
    setNotes((prev) => {
      const ordered = [...prev].sort((a, b) =>
        !!a.pinned !== !!b.pinned ? (a.pinned ? -1 : 1) : 0
      );
      const from = ordered.findIndex((n) => n.id === noteId);
      if (from < 0) return prev;
      const moved = ordered[from];
      const pinnedCount = ordered.filter((n) => n.pinned).length;
      // 置顶组占 [0, pinnedCount)，普通组占 [pinnedCount, len)
      const lo = moved.pinned ? 0 : pinnedCount;
      const hi = moved.pinned ? pinnedCount : ordered.length;
      const to = Math.max(lo, Math.min(hi, target));
      if (to === from || to === from + 1) return prev;
      const next = ordered.slice();
      next.splice(from, 1);
      next.splice(to > from ? to - 1 : to, 0, moved);
      return next;
    });
  }, []);

  /** 笔记本 → 挂起（支持重复挂起） */
  const hangNote = useCallback(
    (noteId: string) => {
      const n = notesRef.current.find((x) => x.id === noteId);
      if (!n) return;
      addNoteCard(noteId, n.text);
      reveal();
      showToast("已挂到绳子上");
    },
    [addNoteCard, reveal, showToast]
  );

  /** 笔记本 → 删除（二次确认：绳上卡片一起删） */
  const deleteNote = useCallback(
    async (noteId: string) => {
      const ok = await confirm(
        "删除后，绳子上挂着的该便笺卡片也会一起删除。是否继续？",
        {
          title: "删除便笺",
          kind: "warning",
          okLabel: "删除",
          cancelLabel: "取消",
        }
      );
      if (!ok) return;
      const ids = itemsRef.current
        .filter((i) => i.noteId === noteId)
        .map((i) => i.id);
      if (ids.length > 0) removeItems(ids);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
    },
    [removeItems]
  );

  // ---------- 待办 ----------
  /** 打勾：草稿写回待办与绳上所有引用它的卡片（卡片只存标题） */
  const submitTodo = useCallback(
    (todoId: string, draft: TodoDraft) => {
      const ed = todoEditorsRef.current.find((e) => e.todoId === todoId);
      setTodoEditors((prev) => prev.filter((e) => e.todoId !== todoId));
      if (!ed) return;
      if (!draft.title.trim() && !draft.text.trim() && ed.creating) {
        // 新建却没写内容：连卡片带待办一起丢弃，不留垃圾
        removeItems([ed.cardId]);
        setTodos((prev) => prev.filter((t) => t.id !== ed.todoId));
        return;
      }
      setTodos((prev) =>
        prev.map((t) =>
          t.id === ed.todoId
            ? { ...t, ...draft, title: draft.title.trim(), updatedAt: Date.now() }
            : t
        )
      );
      setItems((prev) =>
        prev.map((i) =>
          i.todoId === ed.todoId
            ? { ...i, name: draft.title.trim() || "待办" }
            : i
        )
      );
    },
    [removeItems]
  );

  /** 关闭编辑窗：新建且一字未写 → 连卡片带待办丢弃，不留空壳 */
  const closeTodoEditor = useCallback(
    (todoId: string, draft: TodoDraft) => {
      const ed = todoEditorsRef.current.find((e) => e.todoId === todoId);
      setTodoEditors((prev) => prev.filter((e) => e.todoId !== todoId));
      if (ed?.creating && !draft.title.trim() && !draft.text.trim()) {
        removeItems([ed.cardId]);
        setTodos((prev) => prev.filter((t) => t.id !== ed.todoId));
      }
    },
    [removeItems]
  );

  /** 完成 / 取消完成：完成后取消置顶（已完成的待办不置顶） */
  const toggleTodoDone = useCallback((todoId: string) => {
    setTodos((prev) =>
      prev.map((t) =>
        t.id === todoId ? { ...t, done: !t.done, pinned: false } : t
      )
    );
  }, []);

  /** 置顶 / 取消置顶（已完成的待办不支持置顶） */
  const togglePinTodo = useCallback((todoId: string) => {
    setTodos((prev) =>
      prev.map((t) => (t.id === todoId && !t.done ? { ...t, pinned: !t.pinned } : t))
    );
  }, []);

  /** 笔记本里拖拽排序：把该待办插到展示顺序的第 index 位。
   *  展示顺序分三组：置顶且未完成 → 未完成 → 已完成，只允许同组内移动 */
  const reorderTodo = useCallback((todoId: string, target: number) => {
    setTodos((prev) => {
      const g = (t: Todo) => (t.done ? 2 : t.pinned ? 0 : 1);
      const ordered = [...prev].sort((a, b) => g(a) - g(b));
      const from = ordered.findIndex((t) => t.id === todoId);
      if (from < 0) return prev;
      const moved = ordered[from];
      const pinnedCount = ordered.filter((t) => !t.done && t.pinned).length;
      const activeCount = ordered.filter((t) => !t.done).length;
      let lo: number;
      let hi: number;
      if (moved.done) {
        lo = activeCount;
        hi = ordered.length;
      } else if (moved.pinned) {
        lo = 0;
        hi = pinnedCount;
      } else {
        lo = pinnedCount;
        hi = activeCount;
      }
      const to = Math.max(lo, Math.min(hi, target));
      if (to === from || to === from + 1) return prev;
      const next = ordered.slice();
      next.splice(from, 1);
      next.splice(to > from ? to - 1 : to, 0, moved);
      return next;
    });
  }, []);

  /** 笔记本 → 挂起（已完成的待办不能挂到绳子上） */
  const hangTodo = useCallback(
    (todoId: string) => {
      const t = todosRef.current.find((x) => x.id === todoId);
      if (!t || t.done) return;
      addTodoCard(todoId, t.title);
      reveal();
      showToast("已挂到绳子上");
    },
    [addTodoCard, reveal, showToast]
  );

  /** 笔记本 → 删除（二次确认：绳上卡片一起删） */
  const deleteTodo = useCallback(
    async (todoId: string) => {
      const ok = await confirm(
        "删除后，绳子上挂着的该待办卡片也会一起删除。是否继续？",
        {
          title: "删除待办",
          kind: "warning",
          okLabel: "删除",
          cancelLabel: "取消",
        }
      );
      if (!ok) return;
      const ids = itemsRef.current
        .filter((i) => i.todoId === todoId)
        .map((i) => i.id);
      if (ids.length > 0) removeItems(ids);
      setTodos((prev) => prev.filter((t) => t.id !== todoId));
    },
    [removeItems]
  );

  /** 笔记本右侧直接编辑待办：实时写回待办与绳上卡片（标题同步到卡片） */
  const editTodoDraft = useCallback((todoId: string, draft: TodoDraft) => {
    setTodos((prev) =>
      prev.map((t) => (t.id === todoId ? { ...t, ...draft } : t))
    );
    setItems((prev) =>
      prev.map((i) =>
        i.todoId === todoId ? { ...i, name: draft.title.trim() || "待办" } : i
      )
    );
  }, []);

  /** 待办编辑结束（失焦）：刷新修改时间 */
  // ---------- 倒计时 ----------
  /** 打勾：草稿写回倒计时与绳上所有引用它的卡片（卡片只存标题） */
  const submitCountdown = useCallback(
    (countdownId: string, draft: CountdownDraft) => {
      const ed = countdownEditorsRef.current.find((e) => e.countdownId === countdownId);
      setCountdownEditors((prev) => prev.filter((e) => e.countdownId !== countdownId));
      if (!ed) return;
      if (
        !draft.title.trim() &&
        !draft.text.trim() &&
        !draft.endAt &&
        ed.creating
      ) {
        // 新建却什么都没填：连卡片带倒计时一起丢弃，不留垃圾
        removeItems([ed.cardId]);
        setCountdowns((prev) => prev.filter((c) => c.id !== ed.countdownId));
        return;
      }
      setCountdowns((prev) =>
        prev.map((c) =>
          c.id === ed.countdownId
            ? { ...c, ...draft, title: draft.title.trim(), updatedAt: Date.now() }
            : c
        )
      );
      setItems((prev) =>
        prev.map((i) =>
          i.countdownId === ed.countdownId
            ? { ...i, name: draft.title.trim() || "倒计时" }
            : i
        )
      );
    },
    [removeItems]
  );

  /** 关闭编辑窗：新建且一个字没填 → 连卡片带倒计时丢弃，不留空壳 */
  const closeCountdownEditor = useCallback(
    (countdownId: string, draft: CountdownDraft) => {
      const ed = countdownEditorsRef.current.find((e) => e.countdownId === countdownId);
      setCountdownEditors((prev) =>
        prev.filter((e) => e.countdownId !== countdownId)
      );
      if (
        ed?.creating &&
        !draft.title.trim() &&
        !draft.text.trim() &&
        !draft.endAt
      ) {
        removeItems([ed.cardId]);
        setCountdowns((prev) => prev.filter((c) => c.id !== ed.countdownId));
      }
    },
    [removeItems]
  );

  /** 置顶 / 取消置顶 */
  const togglePinCountdown = useCallback((countdownId: string) => {
    setCountdowns((prev) =>
      prev.map((c) => (c.id === countdownId ? { ...c, pinned: !c.pinned } : c))
    );
  }, []);

  /** 笔记本里拖拽排序：把该倒计时插到展示顺序的第 index 位（只允许同组内移动） */
  const reorderCountdown = useCallback((countdownId: string, target: number) => {
    setCountdowns((prev) => {
      const ordered = [...prev].sort((a, b) =>
        !!a.pinned !== !!b.pinned ? (a.pinned ? -1 : 1) : 0
      );
      const from = ordered.findIndex((c) => c.id === countdownId);
      if (from < 0) return prev;
      const moved = ordered[from];
      const pinnedCount = ordered.filter((c) => c.pinned).length;
      // 置顶组占 [0, pinnedCount)，普通组占 [pinnedCount, len)
      const lo = moved.pinned ? 0 : pinnedCount;
      const hi = moved.pinned ? pinnedCount : ordered.length;
      const to = Math.max(lo, Math.min(hi, target));
      if (to === from || to === from + 1) return prev;
      const next = ordered.slice();
      next.splice(from, 1);
      next.splice(to > from ? to - 1 : to, 0, moved);
      return next;
    });
  }, []);

  /** 笔记本 → 挂起（支持重复挂起） */
  const hangCountdown = useCallback(
    (countdownId: string) => {
      const c = countdownsRef.current.find((x) => x.id === countdownId);
      if (!c) return;
      addCountdownCard(countdownId, c.title);
      reveal();
      showToast("已挂到绳子上");
    },
    [addCountdownCard, reveal, showToast]
  );

  /** 笔记本 → 删除（二次确认：绳上卡片一起删） */
  const deleteCountdown = useCallback(
    async (countdownId: string) => {
      const ok = await confirm(
        "删除后，绳子上挂着的该倒计时卡片也会一起删除。是否继续？",
        {
          title: "删除倒计时",
          kind: "warning",
          okLabel: "删除",
          cancelLabel: "取消",
        }
      );
      if (!ok) return;
      const ids = itemsRef.current
        .filter((i) => i.countdownId === countdownId)
        .map((i) => i.id);
      if (ids.length > 0) removeItems(ids);
      setCountdownEditors((prev) =>
        prev.filter((e) => e.countdownId !== countdownId)
      );
      setCountdowns((prev) => prev.filter((c) => c.id !== countdownId));
    },
    [removeItems]
  );

  /** 笔记本右侧直接编辑倒计时：实时写回倒计时与绳上卡片（标题同步到卡片） */
  const editCountdownDraft = useCallback(
    (countdownId: string, draft: CountdownDraft) => {
      setCountdowns((prev) =>
        prev.map((c) => (c.id === countdownId ? { ...c, ...draft } : c))
      );
      setItems((prev) =>
        prev.map((i) =>
          i.countdownId === countdownId
            ? { ...i, name: draft.title.trim() || "倒计时" }
            : i
        )
      );
    },
    []
  );

  // 持久化（卡片 / 便笺 / 待办 / 倒计时变化时）。初始状态读完前不回写，避免空数据覆盖磁盘。
  useEffect(() => {
    if (!loadedRef.current) return;
    api
      .saveState(
        items.map((i) =>
          i.kind === "note" && i.noteId
            ? { noteId: i.noteId }
            : i.kind === "todo" && i.todoId
              ? { todoId: i.todoId }
              : i.kind === "countdown" && i.countdownId
                ? { countdownId: i.countdownId }
                : { path: i.path, source: i.source }
        ),
        notes,
        todos,
        countdowns,
        hideEntry
      )
      .catch(console.error);
  }, [items, notes, todos, countdowns, hideEntry]);

  // ---------- 菜单 ----------
  const openCardMenu = (e: React.MouseEvent, item: Item) => {
    e.preventDefault();
    e.stopPropagation();
    // 当前卡片在绳子上的位置（左侧 / 右侧是否有其他卡片）
    const idx = items.findIndex((i) => i.id === item.id);
    const leftIds = items.slice(0, idx).map((i) => i.id);
    const rightIds = items.slice(idx + 1).map((i) => i.id);
    const isNote = item.kind === "note";
    const isTodo = item.kind === "todo";
    const isCountdown = item.kind === "countdown";
    const todo = isTodo
      ? todosRef.current.find((t) => t.id === item.todoId)
      : undefined;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        // 便笺 / 待办 / 倒计时卡片：没有文件可打开，首项换成编辑
        ...(isNote
          ? [
              {
                label: "编辑便笺（双击）",
                bold: true,
                onClick: () => editNoteCard(item),
              },
            ]
          : isTodo
            ? [
                {
                  label: "编辑待办（双击）",
                  bold: true,
                  onClick: () => item.todoId && editTodoCard(item.todoId),
                },
                {
                  label: "查看详情（单击）",
                  onClick: () => setTodoDetailId(item.todoId!),
                },
                {
                  label: todo?.done ? "取消完成待办" : "完成待办",
                  onClick: () => item.todoId && toggleTodoDone(item.todoId),
                },
              ]
            : isCountdown
              ? [
                  {
                    label: "编辑倒计时（双击）",
                    bold: true,
                    onClick: () =>
                      item.countdownId && editCountdownCard(item.countdownId),
                  },
                ]
              : [
              {
                label: "打开（双击）",
                onClick: () => api.openPath(item.path).catch(console.error),
              },
              // 仅拖拽进入的文件展示（剪贴板落地的是临时文件，定位无意义）
              ...(item.source === "drag"
                ? [
                    {
                      label: "打开所在文件夹",
                      onClick: () =>
                        api.showInFolder(item.path).catch(console.error),
                    },
                  ]
                : []),
            ]),
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
              // 便笺卡片另存为 txt：文件名 = 正文前 10 字 + 序号
              const noteFiles: NoteFile[] = items
                .filter((i) => i.kind === "note")
                .map((i, idx) => ({
                  name: noteFileName(i.text ?? "", idx + 1),
                  text: i.text ?? "",
                }));
              const saved = await api.saveToFolder(
                items
                  .filter((i) => i.kind !== "note" && i.kind !== "todo")
                  .map((i) => i.path),
                folder,
                noteFiles,
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
  // 可能超出条带窗口底部 → 临时加高透明窗口容纳，关闭后恢复条带高度。
  // ⚠️ 连续右键（旧菜单还开着就右键另一处）会在同一次提交里「关旧菜单 + 开新菜单」：
  // 此时既不能真的去恢复条带高度（异步 IPC，会和随后的加高互相覆盖），
  // 也不能用 window.innerHeight 判断是否需要加高（它还是上一次加高后的高度，
  // 会误判成「够高」而不再加高）→ 窗口最终停在条带高度，菜单下半截被裁掉。
  useEffect(() => {
    invoke("set_capture_override", { on: !!menu }).catch(() => {});
    // 只要又开了菜单就取消上一次预约的恢复（同一次提交里必然走到这里）
    window.clearTimeout(menuRestoreTimer.current);
    if (menu) {
      cancelHide();
      // 弹窗打开时窗口已全屏化，无需再加高
      if (!modalFullRef.current) {
        // 基准是条带高度，不是 window.innerHeight
        const base = panelHeight(size);
        const need = Math.ceil(menu.y + menu.items.length * 34 + 72);
        const target = Math.max(base, need);
        const cur = menuHRef.current || base;
        // 上一次恢复（缩回条带）的 IPC 可能还在路上：排在它后面再下发加高，
        // 否则两个异步窗口操作顺序不定，菜单可能被恢复动作截掉
        const pending = menuRestoreP.current;
        if (target !== cur || pending) {
          menuHRef.current = target > base ? target : 0;
          menuExpandedRef.current = target > base;
          menuRestoreP.current = null;
          const apply = () =>
            getCurrentWindow()
              .setSize(new LogicalSize(window.innerWidth, target))
              .catch(console.error);
          if (pending) pending.then(apply);
          else apply();
        }
      }
    } else {
      // 延后一拍再恢复：连续右键时上面的分支会把这次恢复取消掉，窗口不会
      // 先缩回条带再被撑高（也不会被这个恢复动作截掉刚打开的菜单）
      menuRestoreTimer.current = window.setTimeout(() => {
        if (menuRef.current) return; // 期间又开了新菜单，交给菜单分支处理
        if (!menuHRef.current) return; // 本来就没加高过
        menuHRef.current = 0;
        menuExpandedRef.current = false;
        // 弹窗仍开着则保持全屏，恢复留给弹窗关闭时处理
        if (!modalFullRef.current) {
          const p = invoke("window_resized").catch(console.error);
          menuRestoreP.current = p;
          p.then(() => {
            if (menuRestoreP.current === p) menuRestoreP.current = null;
          });
        }
      }, 0);
      scheduleHide();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);

  // 弹窗（使用说明 / 便笺 / 笔记本）：打开时窗口临时全屏化，弹窗即可拖到
  // 屏幕任意位置；全部关闭后恢复条带窗口（重新铺满顶部）
  useEffect(() => {
    if (anyModal) {
      cancelHide();
      modalFullRef.current = true;
      (async () => {
        const mon = await currentMonitor();
        const win = getCurrentWindow();
        if (mon) {
          await win.setPosition(mon.position);
          await win.setSize(mon.size);
        }
      })().catch(console.error);
      // 弹窗里有输入框：把窗口带到前台，键盘才能落进来
      getCurrentWindow().setFocus().catch(() => {});
      if (IS_MAC) api.activateApp().catch(() => {});
    } else {
      if (modalFullRef.current) {
        modalFullRef.current = false;
        setHelpRect(null);
        setDlgRects({});
        // 窗口回到条带高度，菜单加高的记录同步作废（否则再次右键会以为还加高着）
        menuHRef.current = 0;
        menuExpandedRef.current = false;
        // 提醒消息还在展示：窗口保持全屏（条带高度会截断消息）
        if (!reminderRef.current) {
          invoke("window_resized").catch(console.error);
        }
      }
      scheduleHide();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyModal]);

  // ---------- 布局（滚轮像素级回看，scrollPx=0 时最新卡片靠右） ----------
  // 入口卡片常驻绳尾：与普通卡片共用同一套布局（可见数 / 滚动 / 折叠堆叠）。
  // 「隐藏入口卡片」勾选后从布局中摘除——不占容量、不渲染、不进命中区
  const allItems = hideEntry ? items : [...items, entryItem];
  const capacity = visibleCapacity(
    allItems.map((it) => it.kind),
    width,
    size
  );
  const visCount = Math.min(allItems.length, capacity);
  const maxScroll = Math.max(0, allItems.length - visCount);
  const sp = spacing(size);
  const maxScrollPx = maxScroll * sp;
  // 删卡片后 clamp；sc 为浮点"卡单位"，startFloat 连续移动可见窗口
  const sc = Math.min(scrollPx, maxScrollPx) / sp;
  const startFloat = maxScroll - sc;
  const start = Math.floor(startFloat);
  // 子格偏移：所有可见卡整体左移 frac 个「左侧边界节距」；凑满一格时窗口切换，
  // 新卡才从折叠区挂进来（徽章数量与折叠同步变化）。
  // 节距取「即将从左侧挂入的卡片 → 当前首卡」的真实中心距：便笺 / 入口卡更宽，
  // 平移距离必须按它算，否则整数格切换时整行会跳几 px
  const pitchIn =
    start > 0
      ? pitchBetween(allItems[start - 1].kind, allItems[start].kind, size)
      : sp;
  const shiftPx = (startFloat - start) * pitchIn;
  const visibleItems = allItems
    .slice(start, start + visCount)
    .map((it, i) => ({ item: it, i }));
  // 可见卡片中心 x：按各自实际宽度铺开（相邻边缘间隙一致），整体居中。
  // 命中区 / 渲染 / 重排映射共用这一份，保证三处永远对齐
  const centers = visibleCenters(
    visibleItems.map((v) => v.item.kind),
    width,
    size
  );
  const folded = allItems.slice(0, start);
  const foldedRight = allItems.slice(start + visCount);
  // 含绳尾入口卡片的全量列表（重排的槽位映射用；items 本身不含入口卡片）
  const allItemsRef = useRef<Item[]>([]);
  allItemsRef.current = allItems;
  // 入口卡片 z 序：恰好压在当前卡片之上，同时留在卡片层级带内——
  // 重排中的卡片（300）/ 掉落动画（+200）仍能盖住它，弹窗（1200+）、
  // 右键菜单（1000）、toast（900）也照常盖在卡片之上
  const entryZ = 10 + items.reduce((m, it) => Math.max(m, it.index), 0) + 1;
  // 夹子拖拽重排用的最新布局参数（window 监听 handler 通过 ref 读取）
  const reorderLayoutRef = useRef({ centers, start, visCount, shiftPx });
  reorderLayoutRef.current = { centers, start, visCount, shiftPx };
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

  // 入口点击：吃掉这一次点击（不穿透到下方窗口），并保持绳子不收起
  const stopEntryClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      cancelHide();
    },
    [cancelHide]
  );

  // 入口卡片左图（便笺）：新建便笺 —— 挂一张卡片 + 弹出编辑窗
  const onNoteEntryClick = useCallback(
    (e: React.MouseEvent) => {
      stopEntryClick(e);
      createNote();
    },
    [createNote, stopEntryClick]
  );

  // 入口卡片中图（待办）：新建待办 —— 挂一张卡片 + 弹出编辑窗
  const onTodoEntryClick = useCallback(
    (e: React.MouseEvent) => {
      stopEntryClick(e);
      createTodo();
    },
    [createTodo, stopEntryClick]
  );

  const onCountdownEntryClick = useCallback(
    (e: React.MouseEvent) => {
      stopEntryClick(e);
      createCountdown();
    },
    [createCountdown, stopEntryClick]
  );

  // 入口卡片右图（笔记本）：打开便笺管理器
  const onNotebookEntryClick = useCallback(
    (e: React.MouseEvent) => {
      stopEntryClick(e);
      bringToFront(NOTEBOOK_KEY);
      setNotebookOpen(true);
    },
    [bringToFront, stopEntryClick]
  );

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
    // 标记重排会话：卡片自身的「拖出为文件/文字」逻辑看到此标记即让路，
    // 否则重排中指针掠过其它卡片会把它们误发起原生拖拽（拖影变成别人的图）
    setReordering(true);
    setReorder({ id: item.id, mx: e.clientX });
    window.dispatchEvent(new CustomEvent("card-drag-start"));
  }, []);

  const endReorder = useCallback(() => {
    setReordering(false);
    if (!reorderRef.current) return;
    setReorder(null);
    window.dispatchEvent(new CustomEvent("card-drag-end"));
  }, []);

  const moveReorder = useCallback((mx: number) => {
    const ro = reorderRef.current;
    if (!ro) return;
    const L = reorderLayoutRef.current;
    // 可见槽位含绳尾入口卡片；它不参与重排——映射到它的槽位时
    // target 会越界（见下方 setItems 里的兜底），卡片排到它左侧即止
    const count = Math.min(allItemsRef.current.length, L.visCount);
    if (count > 0) {
      // 由鼠标 x 反解悬停的可见槽位：取中心离鼠标最近的槽位。
      // 各卡宽度不同（便笺 / 入口更宽），不能用等距公式反解
      const fx = mx + L.shiftPx; // 还原到未整体平移的槽位坐标
      let hoverI = 0;
      let best = Infinity;
      for (let j = 0; j < count; j++) {
        const d = Math.abs(L.centers[j] - fx);
        if (d < best) {
          best = d;
          hoverI = j;
        }
      }
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
      // +NAME_SECOND_LINE：文件名两行后的卡片下半部分也要能点到
      const cardH = (26 + ph + 18 + NAME_SECOND_LINE) * DOCK_MAX + 14;
      // 便笺卡片更大，Dock 放大上限仅 WIDE_DOCK_MAX（1.12）：四周留的
      // 16 / 36px 余量足以覆盖放大外扩，按实际尺寸 + 余量算命中区
      const noteW = noteCardWidth(size) * WIDE_DOCK_MAX + 16;
      const noteH = 26 + noteCardHeight(size) * WIDE_DOCK_MAX + 36;
      // 待办卡片：与便笺同宽，高度矮一档，同口径算命中区
      const todoW = todoCardWidth(size) * WIDE_DOCK_MAX + 16;
      const todoH = 26 + todoCardHeight(size) * WIDE_DOCK_MAX + 36;
      // 倒计时卡片：与待办同宽，高度再留出倒计时条
      const countdownW = countdownCardWidth(size) * WIDE_DOCK_MAX + 16;
      const countdownH = 26 + countdownCardHeight(size) * WIDE_DOCK_MAX + 36;
      // 入口卡片：与便笺卡片同宽、同口径算命中区
      const entryW = entryCardWidth(size) * WIDE_DOCK_MAX + 16;
      const entryH = 26 + entryCardHeight(size) * WIDE_DOCK_MAX + 36;
      for (const v of visibleItems) {
        const cx = centers[v.i] - shiftPx;
        const y = ropeY(cx, width) - PIN_ABOVE;
        const w =
          v.item.kind === "note"
            ? noteW
            : v.item.kind === "todo"
              ? todoW
              : v.item.kind === "countdown"
                ? countdownW
                : v.item.kind === "entry"
                  ? entryW
                  : cardW;
        const h =
          v.item.kind === "note"
            ? noteH
            : v.item.kind === "todo"
              ? todoH
              : v.item.kind === "countdown"
                ? countdownH
                : v.item.kind === "entry"
                  ? entryH
                  : cardH;
        rects.push([cx - w / 2, y - 4, w, h]);
      }
      if (folded.length > 0) {
        rects.push([fanX - (cw + 16) / 2, 14, cw + 16, ph + 70]);
      }
      if (foldedRight.length > 0) {
        rects.push([fanXRight - (cw + 16) / 2, 14, cw + 16, ph + 70]);
      }
    }
    // 弹窗打开：窗口已全屏化（逻辑坐标=屏幕坐标），弹窗矩形（留 16px
    // hover 余量）与卡片命中区合并上报，弹窗期间卡片仍可点击 /
    // 悬停放大 / 滚轮回看 / 拖入挂绳，其余区域照常穿透
    // 待办提醒消息：常驻命中区（绳子收起时只展示消息本身，消息必须可点）
    for (const r of [
      ...Object.values(dlgRects),
      helpRect,
      reminderRect,
    ]) {
      if (!r) continue;
      rects.unshift([r.x - 16, r.y - 16, r.w + 32, r.h + 32]);
    }
    api.setHitRects(rects, panelH, maxScroll > 0).catch(console.error);
  }, [
    items,
    width,
    size,
    revealed,
    menu,
    scrollPx,
    helpRect,
    dlgRects,
    reminderRect,
    hideEntry,
  ]);

  // ---------- 卡片悬停放大 ----------
  // Rust 鼠标钩子转发条带内光标位置（卡片间隙穿透，WebView 自身收不到 move），
  // 鼠标落在哪张卡的水平投影内就放大哪张（普通卡 DOCK_MAX，宽卡 WIDE_DOCK_MAX），
  // 直接写 CSS 变量驱动，不走 React 渲染；邻居不联动
  const applyDock = useCallback(() => {
    const mx = mouseRef.current;
    for (const s of slotsRef.current) {
      const d = mx == null ? Infinity : Math.abs(s.x - mx);
      // 鼠标不在卡片水平范围内（含间隙）：清除变量，transition 平滑缩回
      if (d >= s.w / 2) {
        s.el.style.removeProperty("--dock");
        s.el.style.removeProperty("--dock-wide");
      } else {
        // 两个变量都写，由 CSS 按卡片类型各取所需（--dock-wide 仅宽卡读取）
        s.el.style.setProperty("--dock", DOCK_MAX.toFixed(4));
        s.el.style.setProperty("--dock-wide", WIDE_DOCK_MAX.toFixed(4));
      }
    }
  }, []);

  // 悬停态（点击穿透态补位）：窗口未占用（命中区外）时 WebView 收不到鼠标事件，
  // CSS :hover 不触发——卡片不弹【关闭】按钮、入口图片不放大。这里用钩子转发的
  // 坐标直接判定命中并挂 .hook-hover class，让这些 hover 样式在穿透态同样生效；
  // 窗口被命中区占用后真实鼠标事件到达，:hover 与 .hook-hover 并存，视觉一致。
  // 不改变穿透策略：是否占用窗口仍由原生钩子按命中区决定，这里只补样式反馈。
  const applyHover = useCallback(() => {
    const mx = mouseRef.current;
    const my = mouseYRef.current;
    const hit = (el: HTMLElement) => {
      if (mx == null || my == null) return false;
      const r = el.getBoundingClientRect();
      return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom;
    };
    for (const s of slotsRef.current) {
      const card = s.el.querySelector<HTMLElement>(".card");
      if (card) card.classList.toggle("hook-hover", hit(card));
      // 入口卡片：左右两张图各自判定（移入哪张放大哪张）
      s.el.querySelectorAll<HTMLElement>(".entry-img-btn").forEach((btn) => {
        btn.classList.toggle("hook-hover", hit(btn));
      });
    }
  }, []);

  // 布局变化（增删卡片 / 滚轮回看 / 尺寸档位 / 显示隐藏）后重建卡片索引
  useEffect(() => {
    if (!revealed) {
      // 面板隐藏时清状态，下次唤出从原始大小开始（悬停态一并清除）
      mouseRef.current = null;
      mouseYRef.current = null;
    }
    // 感应区底部：卡片区（含衣夹）下沿 + 14px 余量；低于此不触发（条带下半空白区）
    zoneBottomRef.current =
      ROPE_TOP + sag(width) - PIN_ABOVE + 26 + photoMaxHeight(size) + 14 + NAME_SECOND_LINE;
    const panel = panelRef.current;
    if (!panel) return;
    slotsRef.current = Array.from(
      panel.querySelectorAll<HTMLElement>(".pegged-slot"),
    ).map((el) => ({
      el,
      x: parseFloat(el.dataset.x || "0"),
      // 各卡片组件都在内联样式写了真实卡宽 --card-w，直接读取做命中判定
      w: parseFloat(el.style.getPropertyValue("--card-w")) || cardWidth(size),
    }));
    applyDock();
    applyHover(); // 布局变化 / 隐藏：悬停态同步重置
  }, [items, width, size, scrollPx, revealed, hideEntry, applyDock, applyHover]);

  useEffect(() => {
    const un = listen<[number, number] | null>("panel-mouse", (e) => {
      const p = e.payload;
      const inZone = !!p && p[1] <= zoneBottomRef.current;
      mouseRef.current = inZone ? p[0] : null;
      mouseYRef.current = inZone ? p[1] : null;
      applyDock();
      applyHover();
    });
    return () => {
      un.then((f) => f());
    };
  }, [applyDock, applyHover]);

  // 待办卡片渲染用的查找表（按 id）
  const todoMap = new Map(todos.map((t) => [t.id, t]));
  const countdownMap = new Map(countdowns.map((c) => [c.id, c]));
  // 当前提醒对应的待办（绳子未唤出时也能算「稍后」上限）
  const remTodo = reminder ? todoMap.get(reminder.todoId) ?? null : null;
  const remMaxSnooze = remTodo?.endAt
    ? Math.max(1, Math.floor((remTodo.endAt - Date.now()) / 60000))
    : 60;

  return (
    <>
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
      <OverflowFan items={folded} x={fanX} size={size} />
      <OverflowFan items={foldedRight} x={fanXRight} size={size} />
      {visibleItems.map(({ item, i }) => {
        const isReorder = item.id === reorder?.id;
        const slotX = centers[i] - shiftPx;
        // 被拖卡片直接跟随鼠标（钳制在首末槽位之间，其余卡片已实时重排腾位）
        const x =
          isReorder && reorder
            ? Math.max(
                centers[0] - shiftPx,
                Math.min(centers[centers.length - 1] - shiftPx, reorder.mx),
              )
            : slotX;
        // 便笺管理入口卡片：常驻绳尾，只响应点击（无右键 / 拖动 / 取下）
        return item.kind === "entry" ? (
          <EntryCard
            key={item.id}
            width={width}
            size={size}
            x={x}
            tilt={item.tilt}
            zIndex={entryZ}
            onNote={onNoteEntryClick}
            onTodo={onTodoEntryClick}
            onNotebook={onNotebookEntryClick}
            onCountdown={onCountdownEntryClick}
          />
        ) : item.kind === "note" ? (
          <NoteCard
            key={item.id}
            item={item}
            width={width}
            size={size}
            x={x}
            reorder={isReorder}
            onPinDown={startReorder}
            onEdit={editNoteCard}
            onContextMenu={openCardMenu}
            onRemove={(id) => removeItems([id])}
            falling={fallingIds.includes(item.id)}
          />
        ) : item.kind === "todo" ? (
          (() => {
            const todo = todoMap.get(item.todoId ?? "");
            if (!todo) return null;
            return (
              <TodoCard
                key={item.id}
                item={item}
                todo={todo}
                width={width}
                size={size}
                x={x}
                reorder={isReorder}
                onPinDown={startReorder}
                onOpenDetail={(it) => it.todoId && setTodoDetailId(it.todoId)}
                onEdit={(it) => it.todoId && editTodoCard(it.todoId)}
                // 打勾完成：标记完成，同时把这张卡片从绳上取下
                onToggleDone={(tid, cid) => {
                  toggleTodoDone(tid);
                  removeItems([cid]);
                }}
                onContextMenu={openCardMenu}
                onRemove={(id) => removeItems([id])}
                falling={fallingIds.includes(item.id)}
              />
            );
          })()
        ) : item.kind === "countdown" ? (
          (() => {
            const countdown = countdownMap.get(item.countdownId ?? "");
            if (!countdown) return null;
            return (
              <CountdownCard
                key={item.id}
                item={item}
                countdown={countdown}
                width={width}
                size={size}
                x={x}
                reorder={isReorder}
                onPinDown={startReorder}
                onEdit={(it) => it.countdownId && editCountdownCard(it.countdownId)}
                onContextMenu={openCardMenu}
                onRemove={(id) => removeItems([id])}
                falling={fallingIds.includes(item.id)}
              />
            );
          })()
        ) : (
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
      {editors.map((ed) => (
        <NoteEditor
          key={ed.noteId}
          initial={ed.text}
          onRect={editorRectFor(ed.noteId)}
          onSubmit={(t) => submitNote(ed.noteId, t)}
          onClose={(t) => closeEditor(ed.noteId, t)}
          z={zMap[editorKey(ed.noteId)] ?? 0}
          onFocus={() => bringToFront(editorKey(ed.noteId))}
        />
      ))}
      {todoEditors.map((ed) => (
        <TodoEditor
          key={ed.todoId}
          initial={ed.draft}
          onRect={editorRectFor(`todo-${ed.todoId}`)}
          onSubmit={(d) => submitTodo(ed.todoId, d)}
          onClose={(d) => closeTodoEditor(ed.todoId, d)}
          z={zMap[todoEditorKey(ed.todoId)] ?? 0}
          onFocus={() => bringToFront(todoEditorKey(ed.todoId))}
        />
      ))}
      {countdownEditors.map((ed) => (
        <CountdownEditor
          key={ed.countdownId}
          initial={ed.draft}
          onRect={editorRectFor(`countdown-${ed.countdownId}`)}
          onSubmit={(d) => submitCountdown(ed.countdownId, d)}
          onClose={(d) => closeCountdownEditor(ed.countdownId, d)}
          z={zMap[countdownEditorKey(ed.countdownId)] ?? 0}
          onFocus={() => bringToFront(countdownEditorKey(ed.countdownId))}
        />
      ))}
      {todoDetailId && todoMap.has(todoDetailId) && (
        <TodoDetail
          todo={todoMap.get(todoDetailId)!}
          onRect={todoDetailRect}
          onEdit={() => editTodoCard(todoDetailId)}
          z={zMap[TODO_DETAIL_KEY] ?? 0}
          onFocus={() => bringToFront(TODO_DETAIL_KEY)}
          onClose={() => setTodoDetailId(null)}
        />
      )}
      {notebookOpen && (
        <Notebook
          notes={notes}
          todos={todos}
          countdowns={countdowns}
          onRect={notebookRect}
          onCreate={createNote}
          onCreateTodo={createTodo}
          onCreateCountdown={createCountdown}
          onHang={hangNote}
          onTogglePin={togglePin}
          onReorder={reorderNote}
          onDelete={deleteNote}
          onEdit={editNoteText}
          onEditEnd={touchNote}
          onHangTodo={hangTodo}
          onTogglePinTodo={togglePinTodo}
          onToggleDone={toggleTodoDone}
          onReorderTodo={reorderTodo}
          onDeleteTodo={deleteTodo}
          onEditTodo={editTodoDraft}
          onHangCountdown={hangCountdown}
          onTogglePinCountdown={togglePinCountdown}
          onReorderCountdown={reorderCountdown}
          onDeleteCountdown={deleteCountdown}
          onEditCountdown={editCountdownDraft}
          z={zMap[NOTEBOOK_KEY] ?? 0}
          onFocus={() => bringToFront(NOTEBOOK_KEY)}
          onClose={() => setNotebookOpen(false)}
        />
      )}
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
      {/* 待办提醒消息：渲染在面板之外——面板收起时（.panel.hidden 有位移变换）
          消息仍能固定在屏幕顶部，此时不展示拖拽绳子，只展示消息本身 */}      {reminder && remTodo && (
        <TodoReminder
          todo={remTodo}
          kind={reminder.kind}
          snoozeMin={snoozeMin}
          maxSnooze={remMaxSnooze}
          onSnoozeMin={setSnoozeMin}
          onSnooze={() => snoozeReminder(reminder, snoozeMin)}
          onClose={closeReminder}
          onRect={reminderRectFor}
        />
      )}
    </>
  );
}
