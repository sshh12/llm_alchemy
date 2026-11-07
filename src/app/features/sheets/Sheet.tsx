// Modal sheet: a bottom sheet on phones, a centered dialog from 640 px (Radix Dialog for
// focus trapping, Escape and scroll locking). Swipe the handle down to dismiss on touch.
import { Dialog } from "radix-ui";
import { useRef, type ReactNode } from "react";
import { CloseIcon } from "../../components/Icons.tsx";

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Plain-text description for assistive tech (visually hidden). */
  description?: string;
  headerExtra?: ReactNode;
  /** data-testid for the dialog (e2e contract). */
  testId?: string;
  children: ReactNode;
}

export function Sheet({ open, onOpenChange, title, description, headerExtra, testId, children }: SheetProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = contentRef.current;
    // Swipe-to-dismiss only for phone bottom sheets (dialogs are centered from 640 px).
    if (!el || e.pointerType === "mouse" || matchMedia("(min-width: 640px)").matches) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const startY = e.clientY;
    const t0 = performance.now();
    e.currentTarget.setPointerCapture(e.pointerId);
    const target = e.currentTarget;
    const move = (ev: PointerEvent) => {
      const dy = Math.max(0, ev.clientY - startY);
      el.style.transform = `translateY(${dy}px)`;
    };
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      const dy = ev.clientY - startY;
      const v = dy / Math.max(1, performance.now() - t0);
      el.style.transition = "transform 0.2s ease";
      if (dy > 120 || v > 0.6) onOpenChange(false);
      el.style.transform = "";
      setTimeout(() => (el.style.transition = ""), 220);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          ref={contentRef}
          className="sheet"
          data-testid={testId}
          onOpenAutoFocus={(e) => {
            // Focus the sheet itself (not the close button) so no focus ring flashes on open.
            e.preventDefault();
            contentRef.current?.focus({ preventScroll: true });
          }}
        >
          <div className="flex-none touch-none px-5 pb-2 pt-2 min-[640px]:pt-4" onPointerDown={onHandleDown}>
            <div className="mx-auto mb-2 h-[4.5px] w-[38px] rounded-full bg-[var(--border-strong)] min-[640px]:hidden" />
            <div className="flex items-center gap-3">
              <Dialog.Title className="font-display min-w-0 flex-1 truncate text-[22px] font-semibold tracking-[-0.015em]">
                {title}
              </Dialog.Title>
              {headerExtra}
              <Dialog.Close className="icon-btn -mr-2" aria-label="Close">
                <CloseIcon />
              </Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">{description ?? ""}</Dialog.Description>
          </div>
          <div className="sheet-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
