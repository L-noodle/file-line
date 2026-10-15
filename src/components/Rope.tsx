import { useEffect, useMemo, useRef } from "react";
import { sag } from "../layout";
import { Spring } from "../spring";

// 绳子：三层描边（阴影/主体/高光）+ 两端渐隐，对齐参考 LineView.swift。
// active：拖拽悬停在可放置区时，叠加彩色流动层作为"可松手"反馈。
export default function Rope({ width, active }: { width: number; active?: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);

  // 唤出弹性：绳先绷紧（下垂 30%），面板滑入后松手——
  // 下垂量欠阻尼弹到自然值，像被一串卡片坠得弹动几下
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const s = sag(width) * 2; // 贝塞尔控制点 = 2·sag
    const top = 10;
    const paths = Array.from(svg.querySelectorAll("path"));
    const setD = (f: number) => {
      const d = `M -20 ${top} Q ${width / 2} ${top + s * f} ${width + 20} ${top}`;
      for (const p of paths) p.setAttribute("d", d);
    };
    let spring: Spring | null = null;
    let t = 0;
    const onReveal = () => {
      spring?.destroy();
      window.clearTimeout(t);
      spring = new Spring(0.3, setD, 90, 4.5); // 构造即绷紧
      t = window.setTimeout(() => spring?.to(1), 150);
    };
    window.addEventListener("rope-reveal", onReveal);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("rope-reveal", onReveal);
      spring?.destroy();
    };
  }, [width]);

  // 拖入提示：文件/文件夹拖到可放置区域时抖动一下（WAAPI，可重复触发）
  useEffect(() => {
    const onWiggle = () => {
      svgRef.current?.animate(
        [
          { transform: "translateY(0)" },
          { transform: "translateY(3px)" },
          { transform: "translateY(-2px)" },
          { transform: "translateY(1.2px)" },
          { transform: "translateY(0)" },
        ],
        { duration: 480, easing: "ease-out" }
      );
    };
    window.addEventListener("rope-wiggle", onWiggle);
    return () => window.removeEventListener("rope-wiggle", onWiggle);
  }, []);

  const { d, maskId, shadowId, mainId, flowId } = useMemo(() => {
    const s = sag(width) * 2; // 贝塞尔控制点 = 2·sag
    const top = 10;
    const d = `M -20 ${top} Q ${width / 2} ${top + s} ${width + 20} ${top}`;
    return {
      d,
      maskId: "rope-fade",
      shadowId: "rope-shadow",
      mainId: "rope-main",
      flowId: "rope-flow-grad",
    };
  }, [width]);

  // 渐变平移周期（与色带 x 范围一致，保证无缝循环）
  const span = width + 40;

  return (
    <svg
      className={"rope" + (active ? " drag-hover" : "")}
      ref={svgRef}
      width={width + 40}
      height={80}
      viewBox={`-20 0 ${width + 40} 80`}
      aria-hidden
    >
      <defs>
        <linearGradient id={maskId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.08" stopColor="#fff" stopOpacity="1" />
          <stop offset="0.92" stopColor="#fff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={`${maskId}-m`}>
          <rect x={-20} y={0} width={width + 40} height={80} fill={`url(#${maskId})`} />
        </mask>
        {/* 可放置反馈：循环色带 + 平移动画 = 彩色沿绳流动 */}
        <linearGradient
          id={flowId}
          gradientUnits="userSpaceOnUse"
          x1={-20}
          y1={0}
          x2={span - 20}
          y2={0}
          spreadMethod="repeat"
        >
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="0.25" stopColor="#818cf8" />
          <stop offset="0.5" stopColor="#e879f9" />
          <stop offset="0.75" stopColor="#fbbf24" />
          <stop offset="1" stopColor="#22d3ee" />
          <animateTransform
            attributeName="gradientTransform"
            type="translate"
            from="0 0"
            to={`${span} 0`}
            dur="1.6s"
            repeatCount="indefinite"
          />
        </linearGradient>
      </defs>
      <g mask={`url(#${maskId}-m)`}>
        {/* 阴影层 */}
        <path
          id={shadowId}
          d={d}
          fill="none"
          stroke="rgba(0,0,0,0.22)"
          strokeWidth={1.2}
          filter="url(#blur12)"
          transform="translate(0 1.2)"
        />
        <defs>
          <filter id="blur12" x="-10%" y="-300%" width="120%" height="700%">
            <feGaussianBlur stdDeviation="1.2" />
          </filter>
        </defs>
        {/* 主体 */}
        <path id={mainId} d={d} fill="none" stroke="rgba(128,128,128,0.55)" strokeWidth={1.2} />
        {/* 高光 */}
        <path
          d={d}
          fill="none"
          stroke="rgba(255,255,255,0.45)"
          strokeWidth={0.4}
          transform="translate(0 -0.35)"
        />
        {/* 可放置反馈：彩色流动层（opacity 由 .drag-hover 过渡控制） */}
        <path
          className="rope-flow"
          d={d}
          fill="none"
          stroke={`url(#${flowId})`}
          strokeWidth={2.4}
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
