// Inline SVG icons (stroke-based, 24px grid, currentColor).
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const SearchIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Svg>
);
export const CloseIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const UndoIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);
export const TidyIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="6.5" height="6.5" rx="2" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="2" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="2" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="2" />
  </Svg>
);
export const BroomIcon = (p: P) => (
  <Svg {...p}>
    <path d="M19 4 12.5 10.5" />
    <path d="M11 9.5 14.5 13c-1 3.5-3.5 6-7.5 7l-3-3c1-4 3.5-6.5 7-7.5Z" />
    <path d="m7.5 16 2-2M10 18.5l1.5-1.5" />
  </Svg>
);
export const PlusIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const SettingsIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
    <circle cx="16" cy="7" r="2.2" />
    <circle cx="8" cy="17" r="2.2" />
  </Svg>
);
export const FlameIcon = (p: P) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <path d="M12.6 2.5c.4 2.6-.6 4.3-2 5.8-1.6 1.7-3.6 3.4-3.6 6.6A5.2 5.2 0 0 0 12 20.5a5.3 5.3 0 0 0 5.3-5.4c0-2-.8-3.5-1.8-4.8-.2 1.2-.8 2.1-1.8 2.6.6-3.6-.3-7.6-1.1-10.4Z" />
  </Svg>
);
export const PinIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5Z" />
    <path d="M12 14v6" />
  </Svg>
);
export const ShareIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 15V4M8 8l4-4 4 4" />
    <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
  </Svg>
);
/** A check that draws itself on mount (see .check-draw). */
export const DrawnCheckIcon = (p: P) => (
  <Svg {...p} className={`check-draw ${p.className ?? ""}`}>
    <path d="m5 12.5 4.5 4.5L19 7.5" pathLength={1} />
  </Svg>
);
export const ChevronUpIcon = (p: P) => (
  <Svg {...p}>
    <path d="m6 15 6-6 6 6" />
  </Svg>
);
export const ChevronDownIcon = (p: P) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);
export const LayersIcon = (p: P) => (
  <Svg {...p}>
    <path d="m12 4 8 4-8 4-8-4 8-4Z" />
    <path d="m4 12 8 4 8-4M4 16l8 4 8-4" />
  </Svg>
);
export const SparkleIcon = (p: P) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <path d="M12 2.5c.5 4.6 2.4 7 7 7.5-4.6.5-6.5 2.9-7 7.5-.5-4.6-2.4-7-7-7.5 4.6-.5 6.5-2.9 7-7.5Z" />
    <path d="M19 15c.2 1.8 1 2.8 2.8 3-1.8.2-2.6 1.2-2.8 3-.2-1.8-1-2.8-2.8-3 1.8-.2 2.6-1.2 2.8-3Z" />
  </Svg>
);
/** Up and down arrows side by side (reverse an order). */
export const ReverseIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8 19V5M4.5 8.5 8 5l3.5 3.5" />
    <path d="M16 5v14M12.5 15.5 16 19l3.5-3.5" />
  </Svg>
);
export const ExternalIcon = (p: P) => (
  <Svg {...p}>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </Svg>
);
export const CopyIcon = (p: P) => (
  <Svg {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2.5" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Svg>
);
export const MoreIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8.5v7M8.5 12h7" />
  </Svg>
);
export const HandIcon = (p: P) => (
  <svg viewBox="0 0 32 32" aria-hidden="true" {...p}>
    <path
      d="M11.5 4.5a2 2 0 0 1 4 0v9l.9-.1V10a2 2 0 0 1 4 0v4l.8.1v-2.6a2 2 0 0 1 4 0v8.2c0 5.4-3.6 9.3-8.7 9.3-3.2 0-5.4-1.4-7.2-4.1l-3.8-5.8a2 2 0 0 1 3-2.6l3 2.8V4.5Z"
      fill="var(--surface)"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

/** The wordmark glyph: a copper crucible with a gold spark. */
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="lm-cu" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#d98a5b" />
          <stop offset="1" stopColor="#8f3a17" />
        </linearGradient>
        <linearGradient id="lm-au" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f6da8a" />
          <stop offset="1" stopColor="#b8861f" />
        </linearGradient>
      </defs>
      <path d="M7 13h18l-2.2 10.4A4 4 0 0 1 18.9 27h-5.8a4 4 0 0 1-3.9-3.6L7 13Z" fill="url(#lm-cu)" />
      <rect x="5.5" y="11" width="21" height="3.4" rx="1.7" fill="url(#lm-cu)" />
      <ellipse cx="16" cy="12.6" rx="8.4" ry="1.1" fill="#2a2118" opacity=".35" />
      <path d="M16 2.5c.4 3.2 1.8 4.8 5 5.2-3.2.4-4.6 2-5 5.2-.4-3.2-1.8-4.8-5-5.2 3.2-.4 4.6-2 5-5.2Z" fill="url(#lm-au)" />
    </svg>
  );
}
