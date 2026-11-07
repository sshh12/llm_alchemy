// Settings: theme, sound, haptics, motion, device transfer (show / redeem a code),
// how to play, credits, and reset progress (hold to confirm).
import { AlertDialog } from "radix-ui";
import { useState, type ReactNode } from "react";
import { ApiFailure, playerAction } from "../../lib/api.ts";
import { supportsHaptics } from "../../lib/haptics.ts";
import { unlockAudio } from "../../lib/sound.ts";
import { KEYS, removeKey } from "../../lib/storage.ts";
import { useCanvas } from "../../state/canvas.ts";
import { resetLibraryLocal, useGame } from "../../state/game.ts";
import { useSettings, type ThemePref } from "../../state/settings.ts";
import { openSheet, showToast } from "../../state/ui.ts";
import { HoldToConfirm } from "../../components/HoldToConfirm.tsx";
import { CopyIcon, ExternalIcon } from "../../components/Icons.tsx";
import { LEARN_MORE_URL, SOURCE_URL } from "../../content.ts";
import { Sheet } from "./Sheet.tsx";

function Row({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[56px] items-center gap-4 py-2">
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {hint && <p className="text-[13px] text-ink-muted">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />;
}

const THEMES: { id: ThemePref; label: string }[] = [
  { id: "system", label: "Auto" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function failureText(e: unknown): string {
  if (e instanceof ApiFailure) {
    if (e.code === "rate_limited") return "Too many tries. Wait a minute and try again.";
    if (e.code === "bad_request" || e.code === "not_found" || e.code === "forbidden") return "That code isn't valid (or was revoked).";
    if (e.code === "network" || e.code === "timeout") return "Couldn't reach the server. Check your connection.";
  }
  return "Something went wrong. Try again.";
}

function Transfer() {
  const [code, setCode] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<"show" | "redeem" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const show = async () => {
    setBusy("show");
    setError(null);
    try {
      const res = await playerAction({ action: "transfer-code" });
      if (res.action === "transfer-code") setCode(res.code);
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(null);
    }
  };
  const redeem = async () => {
    const c = input.trim();
    if (!c) return;
    setBusy("redeem");
    setError(null);
    try {
      await playerAction({ action: "redeem", code: c });
      // A different player now owns this browser: start from a clean workbench.
      removeKey(KEYS.canvas);
      removeKey(KEYS.undo, "session");
      location.reload();
    } catch (e) {
      setError(failureText(e));
      setBusy(null);
    }
  };

  return (
    <div className="rounded-[18px] bg-surface-2 p-4">
      <p className="font-semibold">Play on another device</p>
      <p className="mb-3 text-[13px] text-ink-muted">Your progress lives with this browser. Use a transfer code to continue somewhere else.</p>
      {code ? (
        <div className="flex items-center gap-2">
          <code className="field flex flex-1 items-center overflow-x-auto whitespace-nowrap font-mono text-[13px]">{code}</code>
          <button
            type="button"
            className="btn btn-quiet h-11 flex-none px-3"
            aria-label="Copy code"
            onClick={() => {
              void navigator.clipboard?.writeText(code).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1_500);
              });
            }}
          >
            <CopyIcon size={18} /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-quiet w-full" disabled={busy !== null} onClick={show}>
          {busy === "show" ? "Getting a code…" : "Show my transfer code"}
        </button>
      )}
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void redeem();
        }}
      >
        <input
          className="field flex-1"
          placeholder="Have a code? Paste it here"
          aria-label="Transfer code"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="btn btn-primary flex-none" disabled={!input.trim() || busy !== null}>
          {busy === "redeem" ? "…" : "Use"}
        </button>
      </form>
      <p className="mt-2 text-[12px] text-ink-muted">Using a code switches this browser to that player's library.</p>
      {error && (
        <p className="mt-2 text-[13px] font-semibold text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Reset() {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const reset = async () => {
    setBusy(true);
    try {
      await playerAction({ action: "reset" });
      resetLibraryLocal();
      useCanvas.setState({ tiles: [], selection: [], multi: false, undo: [], redo: [] });
      setConfirming(false);
      openSheet(null);
      showToast({ kind: "info", text: "Fresh start! Your library is back to the five starters.", duration: 5_000 });
    } catch (e) {
      showToast({ kind: "error", text: failureText(e), duration: 5_000 });
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog.Root open={confirming} onOpenChange={setConfirming}>
      <AlertDialog.Trigger asChild>
        <button type="button" className="btn btn-quiet w-full text-danger" data-testid="reset-progress">
          Reset progress…
        </button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay card-overlay" />
        <AlertDialog.Content className="card-dialog p-6 text-left">
          <AlertDialog.Title className="font-display text-[24px] font-semibold">Start over?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-[14.5px] text-ink-muted">
            Your library goes back to the five starters and the workbench is cleared. Your world firsts and challenge history stay
            credited to you. This can't be undone.
          </AlertDialog.Description>
          <div className="mt-5 flex flex-col gap-2">
            <HoldToConfirm testId="reset-confirm" label={busy ? "Resetting…" : "Hold to reset"} disabled={busy} onConfirm={() => void reset()} />
            <AlertDialog.Cancel asChild>
              <button type="button" className="btn btn-quiet w-full">
                Keep my elements
              </button>
            </AlertDialog.Cancel>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export default function SettingsSheet({ open }: { open: boolean }) {
  const s = useSettings();
  const playerSince = useGame((g) => g.player?.createdAt);
  return (
    <Sheet open={open} onOpenChange={(o) => !o && openSheet(null)} title="Settings" description="Appearance, sound, haptics, devices and progress." testId="settings-sheet">
      <div className="divide-y divide-border">
        <Row title="Theme">
          <div className="seg" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={s.theme === t.id} onClick={() => s.set({ theme: t.id })}>
                {t.label}
              </button>
            ))}
          </div>
        </Row>
        <Row title="Sound effects" hint="Soft synthesized chimes">
          <Switch
            label="Sound effects"
            checked={s.sound}
            onChange={(v) => {
              if (v) unlockAudio();
              s.set({ sound: v });
            }}
          />
        </Row>
        {supportsHaptics() && (
          <Row title="Haptics" hint="Little taps when you pick up and combine">
            <Switch label="Haptics" checked={s.haptics} onChange={(v) => s.set({ haptics: v })} />
          </Row>
        )}
        <Row title="Reduce motion" hint="Off follows your device setting">
          <Switch label="Reduce motion" checked={s.motion === "reduce"} onChange={(v) => s.set({ motion: v ? "reduce" : "system" })} />
        </Row>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <Transfer />
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => openSheet("about")}>
            How to play
          </button>
          <a className="btn btn-sm btn-quiet" href={LEARN_MORE_URL} target="_blank" rel="noopener">
            The story <ExternalIcon size={15} />
          </a>
          <a className="btn btn-sm btn-quiet" href={SOURCE_URL} target="_blank" rel="noopener">
            Source <ExternalIcon size={15} />
          </a>
        </div>
        <Reset />
        {playerSince && (
          <p className="text-center text-[12px] text-ink-muted">Alchemist since {new Date(playerSince).toLocaleDateString("en-US", { month: "long", year: "numeric" })}</p>
        )}
      </div>
    </Sheet>
  );
}
