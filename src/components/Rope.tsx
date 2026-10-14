import { useMemo } from "react";
import { sag } from "../layout";

// 绳子：三层描边（阴影/主体/高光）+ 两端渐隐，对齐参考 LineView.swift。
export default function Rope({ width }: { width: number }) {
  const { d, maskId, shadowId, mainId } = useMemo(() => {
    const s = sag(width) * 2; // 贝塞尔控制点 = 2·sag
    const top = 10;
    const d = `M -20 ${top} Q ${width / 2} ${top + s} ${width + 20} ${top}`;
    return {
      d,
      maskId: "rope-fade",
      shadowId: "rope-shadow",
      mainId: "rope-main",
    };
  }, [width]);

  return (
    <svg
      className="rope"
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
      </g>
    </svg>
  );
}
