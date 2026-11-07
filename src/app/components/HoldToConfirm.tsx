// Press and hold (1.5 s) to confirm a destructive action. Keyboard: hold Enter/Space.
import { useRef, useState, type CSSProperties } from "react";

interface Props {
  onConfirm: () => void;
  label: string;
  holdingLabel?: string;
  disabled?: boolean;
  ms?: number;
  testId?: string;
}

export function HoldToConfirm({ onConfirm, label, holdingLabel = "Keep holding…", disabled, ms = 1_500, testId }: Props) {
  const [progress, setProgress] = useState(0);
  const raf = useRef(0);
  const start = useRef(0);

  const stop = () => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    setProgress(0);
  };
  const begin = () => {
    if (disabled || raf.current) return;
    start.current = performance.now();
    const tick = () => {
      const p = Math.min(1, (performance.now() - start.current) / ms);
      setProgress(p);
      if (p >= 1) {
        raf.current = 0;
        setProgress(0);
        onConfirm();
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };

  return (
    <button
      type="button"
      className="btn btn-danger hold-btn w-full select-none"
      data-testid={testId}
      disabled={disabled}
      style={{ "--p": progress } as CSSProperties}
      onPointerDown={begin}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === "Enter" || e.key === " ") stop();
      }}
      aria-label={`${label} (press and hold)`}
    >
      <span className="hold-fill" />
      {progress > 0 ? holdingLabel : label}
    </button>
  );
}
