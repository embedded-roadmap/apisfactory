import type { ReactElement } from "react";
import { code128Widths } from "./code128";

export function Barcode({ value, height = 48, module = 1.6 }: { value: string; height?: number; module?: number }) {
  let widths: number[];
  try {
    widths = code128Widths(value);
  } catch {
    return <span className="mono">{value}</span>;
  }
  const quiet = 10;
  const total = widths.reduce((a, b) => a + b, 0) + quiet * 2;
  let x = quiet;
  const bars: ReactElement[] = [];
  widths.forEach((wd, i) => {
    if (i % 2 === 0) bars.push(<rect key={i} x={x} y={0} width={wd} height={height} />);
    x += wd;
  });
  return (
    <svg role="img" aria-label={`Barkod ${value}`} width={total * module} height={height} viewBox={`0 0 ${total} ${height}`} preserveAspectRatio="none" style={{ background: "#fff", display: "block" }}>
      <g fill="#000">{bars}</g>
    </svg>
  );
}
