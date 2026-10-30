import type { Phase } from "@/components/recorder/use-recorder";

type PipDeckProps = {
  phase: Phase;
  elapsedLabel: string;
  countdownLeft: number;
  onPrimary: () => void;
  onPauseToggle: () => void;
};

function statusLabel(phase: Phase): string {
  if (phase === "recording") return "Recording";
  if (phase === "paused") return "Paused";
  if (phase === "countdown") return "Click the game";
  if (phase === "saving") return "Saving";
  if (phase === "armed") return "Ready";
  return "Nock";
}

export function PipDeck({ phase, elapsedLabel, countdownLeft, onPrimary, onPauseToggle }: PipDeckProps) {
  const primary =
    phase === "countdown" ? "Cancel" : phase === "recording" || phase === "paused" ? "Stop" : phase === "saving" ? "Saving" : "Record";
  const hot = phase === "idle" || phase === "armed" || phase === "recording" || phase === "paused";
  const showPause = phase === "recording" || phase === "paused";
  const readout = phase === "countdown" ? String(countdownLeft) : elapsedLabel;

  return (
    <div className="flex h-screen flex-col justify-between bg-bg p-3 font-sans text-fg">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-sm text-muted">
          {phase === "recording" ? <span className="rec-dot is-live" aria-hidden /> : null}
          {statusLabel(phase)}
        </span>
        <span className="font-mono text-3xl font-medium tabular-nums">{readout}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onPrimary}
          disabled={phase === "saving"}
          className={`h-12 rounded-full text-sm font-semibold disabled:opacity-50 ${hot ? "bg-rec text-on-rec" : "border border-line bg-surface text-fg"}`}
        >
          {primary}
        </button>
        <button
          type="button"
          onClick={onPauseToggle}
          disabled={!showPause}
          className="h-12 rounded-full border border-line bg-surface text-sm font-semibold text-fg disabled:opacity-40"
        >
          {phase === "paused" ? "Resume" : "Pause"}
        </button>
      </div>
    </div>
  );
}
