// Opened from a transfer link (`/#transfer=<code>`, the QR code in Settings) once bootstrap is
// done: confirm before this browser switches to the scanned player.
import { AlertDialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { showToast } from "../../state/ui.ts";
import type { TransferLink } from "../../lib/transferLink.ts";
import { INVALID_CODE_TEXT, failureText, isCurrentPlayer, switchToPlayer } from "./transfer.ts";

type Step = "checking" | "confirm" | "switching" | "done";

let started = false; // once per page load (StrictMode runs mount effects twice in dev)

export default function TransferPrompt({ link }: { link: TransferLink }) {
  const [step, setStep] = useState<Step>("checking");
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (started) return;
    started = true;
    void (async () => {
      if (!link.valid) {
        showToast({ kind: "error", text: INVALID_CODE_TEXT, duration: 6_000 });
        setStep("done");
      } else if (await isCurrentPlayer(link.code)) {
        showToast({ kind: "info", text: "You're already playing as this player", duration: 5_000 });
        setStep("done");
      } else {
        setStep("confirm");
      }
    })();
  }, [link]);

  const switchNow = async () => {
    setStep("switching");
    try {
      await switchToPlayer(link.code); // reloads
    } catch (e) {
      setStep("done");
      showToast({ kind: "error", text: failureText(e), duration: 6_000 });
    }
  };

  const open = step === "confirm" || step === "switching";
  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => !o && step === "confirm" && setStep("done")}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay card-overlay" />
        <AlertDialog.Content
          ref={contentRef}
          className="card-dialog p-6 text-left"
          data-testid="transfer-confirm"
          onOpenAutoFocus={(e) => {
            // It opens on its own, not from a tap: focus the card, so no focus ring flashes on Cancel.
            e.preventDefault();
            contentRef.current?.focus({ preventScroll: true });
          }}
        >
          <AlertDialog.Title className="font-display text-[24px] font-semibold">Continue as another player?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-[14.5px] text-ink-muted">
            This browser will switch to the scanned player and their library. The progress on this device stays with its own player: to
            come back to it later, cancel and save its transfer code in Settings first.
          </AlertDialog.Description>
          <div className="mt-5 flex flex-col gap-2">
            <button type="button" className="btn btn-primary w-full" data-testid="transfer-switch" disabled={step === "switching"} onClick={() => void switchNow()}>
              {step === "switching" ? "Switching…" : "Switch"}
            </button>
            <AlertDialog.Cancel asChild>
              <button type="button" className="btn btn-quiet w-full" data-testid="transfer-cancel" disabled={step === "switching"}>
                Cancel
              </button>
            </AlertDialog.Cancel>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
