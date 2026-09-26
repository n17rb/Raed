'use client';

import { useMemo, useRef, useState, type MouseEvent } from 'react';

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
  format?: (value: number) => string;
}

const WIDTH = 760;
const HEIGHT = 260;
const PAD = { top: 16, right: 16, bottom: 32, left: 48 };

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exponent = Math.pow(10, Math.floor(Math.log10(value)));
  const fraction = value / exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * exponent;
}

function compact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value * 100) / 100);
}

/** Dependency-free SVG chart: lines (default) or grouped bars, with a hover tooltip. */
export function TimeChart({ labels, series, kind = 'line', axisFormat = compact }: { labels: string[]; series: Series[]; kind?: 'line' | 'bar'; axisFormat?: (value: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const max = useMemo(() => niceMax(Math.max(0, ...series.flatMap((item) => item.values))), [series]);
  const count = labels.length;
  const step = count > 1 ? innerW / (count - 1) : innerW;
  const slot = count > 0 ? innerW / count : innerW;
  // Charts read left→right in time even inside the RTL dashboard.
  const x = (index: number) => (kind === 'bar' ? PAD.left + slot * index + slot / 2 : PAD.left + (count > 1 ? step * index : innerW / 2));
  const y = (value: number) => PAD.top + innerH - (value / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ratio * max);
  const labelEvery = Math.max(1, Math.ceil(count / 10));

  const onMove = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * WIDTH;
    if (count === 0) return;
    const raw = kind === 'bar' ? (px - PAD.left) / slot - 0.5 : (px - PAD.left) / (count > 1 ? step : 1);
    setHover(Math.min(count - 1, Math.max(0, Math.round(raw))));
  };

  const hoverLeft = hover !== null && box.current ? (x(hover) / WIDTH) * box.current.clientWidth : 0;
  const hoverTop = hover !== null && box.current ? (y(Math.max(...series.map((item) => item.values[hover] ?? 0))) / HEIGHT) * box.current.clientHeight : 0;
  const barWidth = Math.max(2, Math.min(22, (slot * 0.7) / Math.max(1, series.length)));

  return (
    <div className="chart" ref={box} dir="ltr">
      <div className="chart-legend" dir="rtl">
        {series.map((item) => (
          <span key={item.key} className="legend-item">
            <span className="legend-swatch" style={{ background: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img">
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} stroke="var(--c-divider)" />
            <text x={PAD.left - 8} y={y(tick) + 4} textAnchor="end" fontSize="11" fill="var(--c-text-secondary)">
              {axisFormat(tick)}
            </text>
          </g>
        ))}
        {labels.map((label, index) =>
          index % labelEvery === 0 ? (
            <text key={label} x={x(index)} y={HEIGHT - 10} textAnchor="middle" fontSize="11" fill="var(--c-text-secondary)">
              {label}
            </text>
          ) : null
        )}
        {kind === 'line'
          ? series.map((item) => (
              <g key={item.key}>
                <polyline
                  fill="none"
                  stroke={item.color}
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  points={item.values.map((value, index) => `${x(index)},${y(value)}`).join(' ')}
                />
                {hover !== null && item.values[hover] !== undefined ? <circle cx={x(hover)} cy={y(item.values[hover] ?? 0)} r={4} fill={item.color} stroke="#fff" strokeWidth={2} /> : null}
              </g>
            ))
          : series.map((item, seriesIndex) =>
              item.values.map((value, index) => (
                <rect
                  key={`${item.key}-${index}`}
                  x={x(index) - (barWidth * series.length) / 2 + barWidth * seriesIndex}
                  y={y(value)}
                  width={barWidth}
                  height={Math.max(0, PAD.top + innerH - y(value))}
                  rx={3}
                  fill={item.color}
                  opacity={hover === null || hover === index ? 1 : 0.55}
                />
              ))
            )}
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} stroke="var(--c-border)" strokeDasharray="4 4" /> : null}
      </svg>
      {hover !== null ? (
        <div className="chart-tooltip" style={{ left: hoverLeft, top: hoverTop }} dir="rtl">
          <div className="chart-tooltip-title">{labels[hover]}</div>
          {series.map((item) => (
            <div key={item.key} className="chart-tooltip-row">
              <span className="legend-swatch" style={{ background: item.color }} />
              {item.label}
              <strong>{(item.format ?? compact)(item.values[hover] ?? 0)}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Horizontal bars for ranked categories. */
export function HBars({ items, format = (value: number) => String(value) }: { items: Array<{ label: string; value: number }>; format?: (value: number) => string }) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <div>
      {items.map((item) => (
        <div key={item.label} className="hbar">
          <span className="ellipsis">{item.label}</span>
          <span className="hbar-track">
            <span className="hbar-fill" style={{ width: `${(item.value / max) * 100}%` }} />
          </span>
          <strong>{format(item.value)}</strong>
        </div>
      ))}
    </div>
  );
}
