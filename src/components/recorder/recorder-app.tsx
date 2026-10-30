import { useEffect, useState } from "react";
import {
  Circle,
  Download,
  Keyboard,
  Monitor,
  Pause,
  PictureInPicture2,
  Play,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useRecorder } from "@/components/recorder/use-recorder";
import {
  PROFILES,
  estimateBytes,
  formatBytes,
  formatRate,
  formatTime,
  profileDetail,
  sourceIsHeavy,
  surfaceName,
  downloadBlob,
  type CountdownSec,
  type CursorMode,
} from "@/lib/recorder/model";

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const CURSORS: { value: CursorMode; label: string }[] = [
  { value: "motion", label: "Moving" },
  { value: "always", label: "Always" },
  { value: "never", label: "Hidden" },
];

const COUNTS: { value: CountdownSec; label: string }[] = [
  { value: 0, label: "Off" },
  { value: 3, label: "3s" },
  { value: 5, label: "5s" },
];

export function RecorderApp() {
  const rec = useRecorder();
  const host = useHost();
  const heavy = rec.incoming ? sourceIsHeavy(rec.incoming, rec.resolved) : false;
  const estimate = estimateBytes(rec.resolved.videoBitsPerSecond, rec.withAudio, rec.elapsedMs);
  const software = rec.codec != null && !rec.codec.hardwareLikely;
  const live = rec.phase === "recording" || rec.phase === "paused";
  const active = rec.clips.find((clip) => clip.id === rec.activeClipId) ?? null;

  const recordLabel =
    rec.phase === "countdown" ? "Cancel" : live ? "Stop" : rec.phase === "saving" ? "Saving" : "Record";

  return (
    <div className="nock-shell min-h-screen bg-bg text-fg">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-xs text-rec">NOCK</p>
            <h1 className="mt-1 text-2xl font-medium tracking-tight">Screen recorder</h1>
            <p className="mt-1 max-w-xl text-sm text-muted">{rec.gpuLine}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {host.installEvent ? (
              <button
                type="button"
                className="h-11 rounded-full bg-fg px-4 text-sm font-semibold text-bg"
                onClick={() => {
                  void host.installEvent?.prompt().then(() => host.clearInstall());
                }}
              >
                Install on this PC
              </button>
            ) : null}
            <p className="font-mono text-xs text-faint">
              {rec.codec?.label ?? "H.264"} · {profileDetail(rec.resolved)}
            </p>
          </div>
        </header>

        {host.embedded ? (
          <Banner tone="warn">
            This chat frame cannot capture the desktop. Open Nock in its own Chrome or Edge window, press Record, and
            choose the game or app.
          </Banner>
        ) : null}
        {!host.embedded && !host.canCapture ? (
          <Banner tone="warn">
            Screen capture needs Chrome or Edge on your PC, in its own window. Firefox and in-app browsers encode in
            software and will hitch an Intel HD 520.
          </Banner>
        ) : null}
        {software && !host.embedded ? (
          <Banner tone="warn">
            This browser would encode in software. That stutters games on an HD 520. Open Nock in Chrome or Edge so
            H.264 can go to Intel Quick Sync.
          </Banner>
        ) : null}
        {rec.error ? (
          <Banner tone="warn" onClose={rec.clearError}>
            {rec.error}
          </Banner>
        ) : null}
        {rec.notice ? (
          <Banner tone="quiet" onClose={rec.clearNotice}>
            {rec.notice}
          </Banner>
        ) : null}

        <div className="grid items-start gap-4 lg:grid-cols-3">
          <section className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-3 lg:col-span-2">
            <div className="relative aspect-video overflow-hidden rounded-xl bg-stage">
              <video
                ref={rec.videoRef}
                muted
                playsInline
                autoPlay
                className={rec.mirrorVisible ? "h-full w-full object-contain" : "hidden"}
              />
              {rec.phase === "countdown" ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-stage/80">
                  <p className="text-sm text-muted">Click the game</p>
                  <p className="font-mono text-6xl tabular-nums">{rec.countdownLeft}</p>
                </div>
              ) : null}
              {!rec.mirrorVisible && rec.phase !== "countdown" ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                  <Monitor className="size-8 text-faint" aria-hidden />
                  <p className="max-w-sm text-sm text-muted">
                    {live
                      ? "Preview is off while recording, so the HD 520 is not drawing the game a second time."
                      : rec.incoming
                        ? `${surfaceName(rec.incoming.surface)} is armed${heavy ? ". Nock will shrink it before encode." : "."}`
                        : "Record any game or app. Pick a window, or the whole screen if you need its audio."}
                  </p>
                </div>
              ) : null}
              {live ? (
                <span className="absolute left-3 top-3 inline-flex items-center gap-2 rounded-full bg-bg/80 px-3 py-1 text-xs text-fg">
                  <span className={`rec-dot ${rec.phase === "recording" ? "is-live" : ""}`} aria-hidden />
                  {rec.phase === "paused" ? "Paused" : "Recording"}
                </span>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void rec.onRecord()}
                disabled={rec.phase === "saving"}
                className="inline-flex h-12 items-center gap-2 rounded-full bg-rec px-5 text-sm font-semibold text-on-rec disabled:opacity-50"
              >
                {live ? <Square className="size-4" fill="currentColor" /> : <Circle className="size-4" fill="currentColor" />}
                {recordLabel}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (rec.phase === "recording") rec.onPause();
                  else rec.onResume();
                }}
                disabled={!live}
                className="inline-flex h-12 items-center gap-2 rounded-full border border-line bg-surface-2 px-4 text-sm font-semibold disabled:opacity-40"
              >
                {rec.phase === "paused" ? <Play className="size-4" /> : <Pause className="size-4" />}
                {rec.phase === "paused" ? "Resume" : "Pause"}
              </button>
              <button
                type="button"
                onClick={() => void rec.onChoose()}
                disabled={rec.locked}
                className="inline-flex h-12 items-center gap-2 rounded-full border border-line px-4 text-sm font-semibold disabled:opacity-40"
              >
                Choose window
              </button>
              <button
                type="button"
                onClick={rec.openFloat}
                disabled={!host.pip}
                className="inline-flex h-12 items-center gap-2 rounded-full border border-line px-4 text-sm font-semibold disabled:opacity-40"
              >
                <PictureInPicture2 className="size-4" />
                {rec.pipOpen ? "Float open" : "Float"}
              </button>
              <p className="ml-auto font-mono text-2xl tabular-nums" aria-live="polite">
                {formatTime(rec.elapsedMs)}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-faint">
              <span className="inline-flex items-center gap-2">
                <Keyboard className="size-4" aria-hidden />
                F9 record or stop · F10 pause
              </span>
              <span className="font-mono">
                {live || rec.phase === "countdown" ? `about ${formatBytes(estimate)}` : "Saves to Downloads"}
                {rec.incoming ? ` · ${rec.incoming.width}×${rec.incoming.height}` : ""}
                {heavy ? " scaled" : ""}
              </span>
            </div>
          </section>

          <aside className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-3">
            <div>
              <h2 className="px-1 text-sm font-medium">Profile</h2>
              <div className="mt-2 flex flex-col gap-2" role="radiogroup" aria-label="Encode profile">
                {PROFILES.map((profile) => {
                  const selected = rec.settings.profileId === profile.id;
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={rec.locked}
                      onClick={() => rec.update({ profileId: profile.id })}
                      className={`rounded-xl border px-3 py-3 text-left disabled:opacity-50 ${selected ? "border-fg bg-surface-2" : "border-line"}`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{profile.name}</span>
                        {profile.recommended ? <span className="font-mono text-xs text-rec">HD 520</span> : null}
                      </span>
                      <span className="mt-1 block text-sm text-muted">{profile.blurb}</span>
                      <span className="mt-1 block font-mono text-xs text-faint">{profileDetail(profile)}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <Switch
              on={rec.settings.highFrameRate}
              disabled={rec.locked}
              label="60 fps"
              hint="Off for games. The HD 520 hitches when a 3D app and a 60 fps encode share the chip."
              onChange={(highFrameRate) => rec.update({ highFrameRate })}
            />
            <Switch
              on={rec.settings.wantSystemAudio}
              disabled={rec.locked}
              label="App audio"
              hint="On Windows, Chrome only shares audio with Entire screen. Nock then scales that picture down."
              onChange={(wantSystemAudio) => rec.update({ wantSystemAudio })}
            />
            <Switch
              on={rec.settings.wantMic}
              disabled={rec.locked}
              label={rec.micReady ? "Microphone on" : "Microphone"}
              hint="Commentary, mixed quietly at 96 kbps."
              onChange={(on) => void rec.setMicWanted(on)}
            />
            <Switch
              on={rec.settings.hidePreview}
              disabled={rec.locked}
              label="Hide preview while recording"
              hint="Leave this on. A live mirror makes the GPU draw the game twice."
              onChange={(hidePreview) => rec.update({ hidePreview })}
            />
            <Switch
              on={rec.settings.floatOnRecord}
              disabled={rec.locked}
              label="Float controls on record"
              hint={host.pip ? "A small always-on-top window in Chrome or Edge." : "Floating controls need Chrome or Edge."}
              onChange={(floatOnRecord) => rec.update({ floatOnRecord })}
            />
            <Switch
              on={rec.settings.autoDownload}
              disabled={rec.locked}
              label="Save to Downloads"
              hint="Takes also stay in this list until you close the app."
              onChange={(autoDownload) => rec.update({ autoDownload })}
            />

            <div className="grid gap-3">
              <Segment
                label="Countdown"
                value={rec.settings.countdownSec}
                options={COUNTS}
                disabled={rec.locked}
                onChange={(countdownSec) => rec.update({ countdownSec })}
              />
              <Segment
                label="Cursor"
                value={rec.settings.cursor}
                options={CURSORS}
                disabled={rec.locked}
                onChange={(cursor) => rec.update({ cursor })}
              />
            </div>

            <div className="rounded-xl bg-stage px-3 py-3 text-sm text-muted">
              <p className="font-medium text-fg">Keep the game smooth</p>
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-4">
                <li>Run the game borderless, not exclusive fullscreen.</li>
                <li>Leave Smooth on. Use Feather only if a 3D game still stutters.</li>
                <li>Turn on hardware acceleration in Chrome so H.264 reaches the Intel encoder.</li>
              </ul>
            </div>
          </aside>
        </div>

        <section className="rounded-2xl border border-line bg-surface p-3">
          <div className="flex items-baseline justify-between gap-3 px-1">
            <h2 className="text-sm font-medium">Takes</h2>
            <p className="text-xs text-faint">{rec.clips.length === 0 ? "None yet" : `${rec.clips.length} in this tab`}</p>
          </div>
          {active && live ? (
            <p className="px-1 pt-3 text-sm text-muted">Playback waits until you stop, so the game keeps the chip.</p>
          ) : null}
          {active && !live ? (
            <video
              key={active.id}
              src={active.url}
              controls
              playsInline
              preload="metadata"
              className="mt-3 aspect-video w-full rounded-xl bg-stage"
            />
          ) : null}
          {rec.clips.length === 0 ? (
            <p className="px-1 py-6 text-sm text-muted">
              Finished recordings show up here as MP4 when the browser can write H.264. Download before you close the
              tab — they are not uploaded anywhere.
            </p>
          ) : (
            <ul className="mt-2">
              {rec.clips.map((clip) => {
                const selected = clip.id === active?.id;
                return (
                  <li key={clip.id} className="flex items-center gap-2 border-t border-line py-2">
                    <button
                      type="button"
                      onClick={() => rec.setActiveClipId(selected ? null : clip.id)}
                      className="min-w-0 flex-1 rounded-lg px-2 py-2 text-left"
                    >
                      <span className={`block truncate text-sm font-medium ${selected ? "text-rec" : ""}`}>{clip.name}</span>
                      <span className="mt-1 block truncate font-mono text-xs text-muted">
                        {formatTime(clip.durationMs)} · {formatBytes(clip.bytes)} · {clip.height ? `${clip.height}p` : clip.profileName} ·{" "}
                        {clip.codecLabel}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Download ${clip.name}`}
                      onClick={() => downloadBlob(clip.blob, clip.name)}
                      className="inline-flex size-11 items-center justify-center rounded-full border border-line"
                    >
                      <Download className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${clip.name}`}
                      onClick={() => rec.removeClip(clip.id)}
                      className="inline-flex size-11 items-center justify-center rounded-full border border-line"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Banner({
  children,
  tone,
  onClose,
}: {
  children: string;
  tone: "warn" | "quiet";
  onClose?: () => void;
}) {
  return (
    <div
      className={`flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm ${tone === "warn" ? "border-rec bg-surface text-fg" : "border-line bg-surface text-muted"}`}
      role={tone === "warn" ? "alert" : "status"}
    >
      <p className="min-w-0 flex-1">{children}</p>
      {onClose ? (
        <button type="button" aria-label="Dismiss" onClick={onClose} className="inline-flex size-8 items-center justify-center rounded-full">
          <X className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

function Switch({
  on,
  label,
  hint,
  disabled,
  onChange,
}: {
  on: boolean;
  label: string;
  hint: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="flex w-full items-center justify-between gap-3 rounded-xl border border-line px-3 py-3 text-left disabled:opacity-50"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-1 block text-sm text-muted">{hint}</span>
      </span>
      <span className={`flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 ${on ? "bg-rec" : "bg-stage"}`} aria-hidden>
        <span className={`block size-5 rounded-full ${on ? "translate-x-5 bg-on-rec" : "bg-fg"}`} />
      </span>
    </button>
  );
}

function Segment<T extends string | number>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  disabled?: boolean;
  onChange: (next: T) => void;
}) {
  return (
    <div>
      <p className="px-1 text-sm font-medium">{label}</p>
      <div role="radiogroup" aria-label={label} className="mt-2 grid grid-cols-3 gap-2">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={String(option.value)}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={`h-11 rounded-full border text-sm font-medium disabled:opacity-50 ${selected ? "border-fg bg-surface-2" : "border-line"}`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function useHost() {
  const [embedded, setEmbedded] = useState(false);
  const [canCapture, setCanCapture] = useState(true);
  const [pip, setPip] = useState(false);
  const [installEvent, setInstallEvent] = useState<InstallPrompt | null>(null);

  useEffect(() => {
    try {
      setEmbedded(window.self !== window.top);
    } catch {
      setEmbedded(true);
    }
    setCanCapture(window.isSecureContext && typeof navigator.mediaDevices?.getDisplayMedia === "function");
    setPip("documentPictureInPicture" in window);
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as InstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  return {
    embedded,
    canCapture,
    pip,
    installEvent,
    clearInstall: () => setInstallEvent(null),
  };
}
