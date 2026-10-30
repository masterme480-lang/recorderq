import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PipDeck } from "@/components/recorder/pip-deck";
import {
  clipFilename,
  defaultSettings,
  detectGpuLabel,
  downloadBlob,
  extFromMime,
  gpuHeadline,
  humanizeCaptureError,
  labelFromMime,
  loadSettings,
  pickCodec,
  resolveProfile,
  sourceIsHeavy,
  STORAGE_KEY,
  type Clip,
  type CodecChoice,
  type CountdownSec,
  type CursorMode,
  type Incoming,
  type ProfileId,
  type Settings,
} from "@/lib/recorder/model";

export type Phase = "idle" | "armed" | "countdown" | "recording" | "paused" | "saving";

type SaveSnap = {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  profileName: string;
};

type DisplayCaptureOptions = DisplayMediaStreamOptions & {
  preferCurrentTab?: boolean;
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  systemAudio?: "include" | "exclude";
  monitorTypeSurfaces?: "include" | "exclude";
  video?: boolean | (MediaTrackConstraints & { cursor?: CursorMode });
};

const MAX_CLIPS = 8;
const MAX_BYTES = 700 * 1024 * 1024;

function displayLive(stream: MediaStream | null): boolean {
  return stream?.getVideoTracks()[0]?.readyState === "live";
}

function mixAudio(
  display: MediaStream,
  mic: MediaStream | null,
  wantSystem: boolean,
  existing: AudioContext | null,
): { stream: MediaStream; ctx: AudioContext | null; nodes: AudioNode[]; usedMix: boolean } {
  const out = new MediaStream();
  const video = display.getVideoTracks()[0];
  if (video) out.addTrack(video);
  const system = wantSystem ? display.getAudioTracks()[0] : undefined;
  const micTrack = mic?.getAudioTracks().find((track) => track.readyState === "live");

  if (!(system && micTrack)) {
    if (system) out.addTrack(system);
    else if (micTrack) out.addTrack(micTrack);
    return { stream: out, ctx: null, nodes: [], usedMix: false };
  }

  try {
    const ctx = existing && existing.state !== "closed" ? existing : new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const systemNode = ctx.createMediaStreamSource(new MediaStream([system]));
    const micNode = ctx.createMediaStreamSource(new MediaStream([micTrack]));
    systemNode.connect(dest);
    micNode.connect(dest);
    const mixed = dest.stream.getAudioTracks()[0];
    if (mixed) out.addTrack(mixed);
    return { stream: out, ctx, nodes: [dest, systemNode, micNode], usedMix: true };
  } catch {
    out.addTrack(system);
    return { stream: out, ctx: null, nodes: [], usedMix: false };
  }
}

async function requestDisplay(settings: Settings): Promise<MediaStream> {
  const profile = resolveProfile(settings);
  const video = {
    frameRate: { ideal: profile.fps, max: profile.fps },
    width: { ideal: profile.width, max: profile.width },
    height: { ideal: profile.height, max: profile.height },
    cursor: settings.cursor,
  };
  const shared = {
    video,
    preferCurrentTab: false,
    selfBrowserSurface: "exclude" as const,
    surfaceSwitching: "include" as const,
    monitorTypeSurfaces: "include" as const,
  };
  if (!settings.wantSystemAudio) {
    return navigator.mediaDevices.getDisplayMedia({
      ...shared,
      audio: false,
      systemAudio: "exclude",
    } as DisplayCaptureOptions);
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      ...shared,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: "include",
    } as DisplayCaptureOptions);
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    if (name !== "OverconstrainedError" && name !== "NotSupportedError") throw error;
    return navigator.mediaDevices.getDisplayMedia({ ...shared, audio: false } as DisplayCaptureOptions);
  }
}

async function applyEncodeSize(track: MediaStreamTrack, settings: Settings) {
  const profile = resolveProfile(settings);
  try {
    await track.applyConstraints({
      width: { ideal: profile.width, max: profile.width },
      height: { ideal: profile.height, max: profile.height },
      frameRate: { ideal: profile.fps, max: profile.fps },
      resizeMode: "crop-and-scale",
    } as MediaTrackConstraints);
  } catch {
    /* The browser kept its own size. Bitrate is still capped. */
  }
  try {
    track.contentHint = "motion";
  } catch {
    /* contentHint is optional. */
  }
}

async function scaleVideoTrack(
  track: MediaStreamTrack,
  width: number,
  height: number,
  fps: number,
): Promise<{ stream: MediaStream; stop: () => void } | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) return null;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  try {
    await video.play();
  } catch {
    video.srcObject = null;
    return null;
  }
  if (video.readyState < 2) {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      video.addEventListener("loadeddata", done, { once: true });
      window.setTimeout(done, 400);
    });
  }
  if (video.readyState < 2) {
    video.pause();
    video.srcObject = null;
    return null;
  }
  const draw = () => {
    if (video.readyState >= 2) ctx.drawImage(video, 0, 0, width, height);
  };
  draw();
  const timer = window.setInterval(draw, Math.max(33, Math.round(1000 / fps)));
  const stream = canvas.captureStream(fps);
  return {
    stream,
    stop: () => {
      window.clearInterval(timer);
      video.pause();
      video.srcObject = null;
    },
  };
}

export function useRecorder() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [hydrated, setHydrated] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [clips, setClips] = useState<Clip[]>([]);
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [countdownLeft, setCountdownLeft] = useState(0);
  const [codec, setCodec] = useState<CodecChoice | null>(null);
  const [gpuLabel, setGpuLabel] = useState<string | null>(null);
  const [gpuChecked, setGpuChecked] = useState(false);
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [hasSystemAudio, setHasSystemAudio] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [pipOpen, setPipOpen] = useState(false);
  const [previewEpoch, setPreviewEpoch] = useState(0);

  const settingsRef = useRef(settings);
  const phaseRef = useRef<Phase>("idle");
  const incomingRef = useRef<Incoming | null>(null);
  const displayRef = useRef<MediaStream | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const audioNodesRef = useRef<AudioNode[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const elapsedRef = useRef({ accum: 0, startedAt: 0 });
  const timerRef = useRef<number | null>(null);
  const countRef = useRef<number | null>(null);
  const shareGen = useRef(0);
  const recordToken = useRef(0);
  const countdownToken = useRef(0);
  const busyRef = useRef(false);
  const startingRef = useRef(false);
  const stoppingRef = useRef(false);
  const goIdleAfterSaveRef = useRef(false);
  const pendingSave = useRef<SaveSnap | null>(null);
  const encodeMetaRef = useRef<SaveSnap | null>(null);
  const scaleStopRef = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const pipRef = useRef<{ win: Window; root: Root } | null>(null);
  const actions = useRef({
    onRecord: () => undefined as void,
    onPause: () => undefined as void,
    onResume: () => undefined as void,
  });

  const setPhaseSafe = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const captureAborted = (token: number) =>
    !mounted.current || recordToken.current !== token || phaseRef.current === "idle";

  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      settingsRef.current = next;
      return next;
    });
  };

  const stopTicker = () => {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const clearCountdown = () => {
    if (countRef.current != null) {
      window.clearInterval(countRef.current);
      countRef.current = null;
    }
  };

  const closeAudio = () => {
    audioNodesRef.current = [];
    const ctx = audioRef.current;
    audioRef.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close();
  };

  const closeMic = () => {
    micRef.current?.getTracks().forEach((track) => track.stop());
    micRef.current = null;
    if (mounted.current) setMicReady(false);
  };

  const releaseDisplay = () => {
    shareGen.current += 1;
    scaleStopRef.current?.();
    scaleStopRef.current = null;
    const stream = displayRef.current;
    displayRef.current = null;
    incomingRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    if (!mounted.current) return;
    setIncoming(null);
    setHasSystemAudio(false);
    setPreviewEpoch((value) => value + 1);
  };

  const startTicker = () => {
    stopTicker();
    timerRef.current = window.setInterval(() => {
      if (phaseRef.current !== "recording") return;
      const clock = elapsedRef.current;
      setElapsedMs(clock.accum + (performance.now() - clock.startedAt));
    }, 1000);
  };

  const frozenMs = () => {
    const clock = elapsedRef.current;
    if (phaseRef.current === "recording") return clock.accum + (performance.now() - clock.startedAt);
    return clock.accum;
  };

  const remember = (clip: Clip) => {
    setClips((prev) => {
      const next = [clip, ...prev];
      let total = next.reduce((sum, item) => sum + item.bytes, 0);
      while (next.length > 1 && (next.length > MAX_CLIPS || total > MAX_BYTES)) {
        const dropped = next.pop();
        if (dropped) URL.revokeObjectURL(dropped.url);
        total = next.reduce((sum, item) => sum + item.bytes, 0);
      }
      return next;
    });
  };

  const removeClip = (id: string) => {
    setClips((prev) => {
      const clip = prev.find((item) => item.id === id);
      if (clip) URL.revokeObjectURL(clip.url);
      return prev.filter((item) => item.id !== id);
    });
    setActiveClipId((current) => (current === id ? null : current));
  };

  const finishSave = (blob: Blob, mime: string, snap: SaveSnap | null) => {
    if (!mounted.current) return;
    if (blob.size <= 0) {
      setError("Nothing was captured. Choose the window again.");
      return;
    }
    const codecChoice = pickCodec(blob.type.includes("audio") || mime.includes("mp4a") || mime.includes("opus"));
    const ext = extFromMime(mime, codecChoice.ext);
    const name = clipFilename(ext);
    const clip: Clip = {
      id: crypto.randomUUID(),
      url: URL.createObjectURL(blob),
      blob,
      name,
      createdAt: Date.now(),
      durationMs: snap?.durationMs ?? 0,
      bytes: blob.size,
      mime,
      width: snap?.width ?? 0,
      height: snap?.height ?? 0,
      fps: snap?.fps ?? 0,
      profileName: snap?.profileName ?? "Recording",
      codecLabel: labelFromMime(mime),
    };
    remember(clip);
    if (settingsRef.current.autoDownload) {
      downloadBlob(blob, name);
      setNotice(`Saved ${name} to Downloads.`);
    } else {
      setNotice("Take is ready in the list. Download it before you close the page.");
    }
  };

  const onShareEnded = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      goIdleAfterSaveRef.current = true;
      stop();
      return;
    }
    recordToken.current += 1;
    countdownToken.current += 1;
    clearCountdown();
    releaseDisplay();
    closeAudio();
    if (!mounted.current) return;
    setCountdownLeft(0);
    setElapsedMs(0);
    elapsedRef.current = { accum: 0, startedAt: 0 };
    setPhaseSafe("idle");
    setNotice("Sharing stopped.");
  };

  const acquire = async (): Promise<boolean> => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) {
      setError("Screen recording needs Chrome or Edge on your PC, opened as its own window or tab.");
      return false;
    }
    let stream: MediaStream;
    try {
      stream = await requestDisplay(settingsRef.current);
    } catch (captureError) {
      if (mounted.current) setError(humanizeCaptureError(captureError));
      return false;
    }
    if (!mounted.current) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((item) => item.stop());
      setError("The browser didn't share a picture.");
      return false;
    }
    await applyEncodeSize(track, settingsRef.current);
    if (!mounted.current) {
      stream.getTracks().forEach((item) => item.stop());
      return false;
    }

    const gen = ++shareGen.current;
    const previous = displayRef.current;
    displayRef.current = stream;
    track.addEventListener("ended", () => {
      if (shareGen.current !== gen) return;
      onShareEnded();
    });
    previous?.getTracks().forEach((item) => item.stop());

    const reported = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
    const nextIncoming: Incoming = {
      width: reported.width ?? 0,
      height: reported.height ?? 0,
      fps: Math.round(reported.frameRate ?? 0),
      surface: reported.displaySurface ?? "",
    };
    incomingRef.current = nextIncoming;
    const sysAudio = stream.getAudioTracks().length > 0;
    setIncoming(nextIncoming);
    setHasSystemAudio(sysAudio);
    setPreviewEpoch((value) => value + 1);
    setPhaseSafe("armed");

    if (settingsRef.current.wantSystemAudio && !sysAudio) {
      setNotice(
        nextIncoming.surface === "window"
          ? "No game audio from a window on Windows. Pick Entire screen when you need sound. Picture still records."
          : "No audio came with this source. The picture will still record.",
      );
    } else if (sourceIsHeavy(nextIncoming, resolveProfile(settingsRef.current))) {
      setNotice("The browser kept a large source. A single window is lighter than a whole screen. Use Feather if the game stutters.");
    } else {
      setNotice(null);
    }
    return true;
  };

  const startEncoder = async () => {
    const myToken = recordToken.current;
    if (startingRef.current || stoppingRef.current) return;
    const display = displayRef.current;
    const videoTrack = display?.getVideoTracks()[0];
    if (!display || !videoTrack || videoTrack.readyState !== "live") {
      setPhaseSafe("idle");
      setError("The shared window closed before recording started.");
      return;
    }
    startingRef.current = true;
    try {
      await applyEncodeSize(videoTrack, settingsRef.current);
      if (captureAborted(myToken)) return;

      let mic = micRef.current;
      if (settingsRef.current.wantMic && !mic?.getAudioTracks().some((track) => track.readyState === "live")) {
        try {
          mic = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: settingsRef.current.wantSystemAudio,
              noiseSuppression: false,
              autoGainControl: false,
              channelCount: 1,
            },
            video: false,
          });
          if (!mounted.current || !settingsRef.current.wantMic || recordToken.current !== myToken) {
            mic.getTracks().forEach((track) => track.stop());
            return;
          }
          closeMic();
          micRef.current = mic;
          setMicReady(true);
        } catch {
          mic = null;
          if (mounted.current) {
            setMicReady(false);
            setNotice("Microphone was blocked. Recording continues without it.");
          }
        }
      }

      if (captureAborted(myToken)) return;

      const currentSettings = settingsRef.current;
      const profile = resolveProfile(currentSettings);
      const built = mixAudio(
        display,
        currentSettings.wantMic ? micRef.current : null,
        currentSettings.wantSystemAudio,
        audioRef.current,
      );
      if (!built.usedMix && audioRef.current) closeAudio();
      if (built.ctx) {
        audioRef.current = built.ctx;
        audioNodesRef.current = built.nodes;
        if (built.ctx.state === "suspended") {
          try {
            await built.ctx.resume();
          } catch {
            /* Mix may stay silent if the browser suspended audio. */
          }
        }
      }
      if (captureAborted(myToken)) return;

      const reported = videoTrack.getSettings();
      const sourceWidth = reported.width || profile.width;
      const sourceHeight = reported.height || profile.height;
      const sourceFps = Math.round(reported.frameRate || incomingRef.current?.fps || 0);
      const shouldScale = sourceIsHeavy(
        { width: sourceWidth, height: sourceHeight, fps: sourceFps, surface: incomingRef.current?.surface ?? "" },
        profile,
      );
      let encodeStream = built.stream;
      let didScale = false;
      if (shouldScale) {
        const scaled = await scaleVideoTrack(videoTrack, profile.width, profile.height, profile.fps);
        if (scaled) {
          const scaledVideo = scaled.stream.getVideoTracks()[0];
          if (!scaledVideo) {
            scaled.stop();
          } else {
            scaleStopRef.current?.();
            scaleStopRef.current = scaled.stop;
            const merged = new MediaStream();
            merged.addTrack(scaledVideo);
            for (const audioTrack of built.stream.getAudioTracks()) merged.addTrack(audioTrack);
            encodeStream = merged;
            didScale = true;
          }
        }
      }

      if (captureAborted(myToken)) {
        scaleStopRef.current?.();
        scaleStopRef.current = null;
        return;
      }

      const hasAudio = encodeStream.getAudioTracks().length > 0;
      const chosen = pickCodec(hasAudio);
      const chunks: Blob[] = [];
      const options: MediaRecorderOptions = { videoBitsPerSecond: profile.videoBitsPerSecond };
      if (chosen.mime) options.mimeType = chosen.mime;
      if (hasAudio) options.audioBitsPerSecond = 96_000;

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(encodeStream, options);
      } catch {
        try {
          recorder = chosen.mime
            ? new MediaRecorder(encodeStream, { mimeType: chosen.mime })
            : new MediaRecorder(encodeStream);
        } catch {
          recorder = new MediaRecorder(encodeStream);
        }
      }

      const snapBase: SaveSnap = {
        durationMs: 0,
        width: didScale ? profile.width : sourceWidth,
        height: didScale ? profile.height : sourceHeight,
        fps: profile.fps,
        profileName: profile.name,
      };
      encodeMetaRef.current = snapBase;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (mounted.current) setError("The encoder stopped. Switch to Feather and try again.");
      };
      recorder.onstop = () => {
        stoppingRef.current = false;
        recorderRef.current = null;
        stopTicker();
        scaleStopRef.current?.();
        scaleStopRef.current = null;
        const snap = pendingSave.current ?? { ...snapBase, durationMs: frozenMs() };
        pendingSave.current = null;
        encodeMetaRef.current = null;
        closeAudio();
        const mime = recorder.mimeType || chosen.mime || "video/webm";
        const blob = new Blob(chunks, { type: mime });
        const ended = goIdleAfterSaveRef.current || !displayLive(displayRef.current);
        goIdleAfterSaveRef.current = false;
        if (ended) releaseDisplay();
        finishSave(blob, mime, snap);
        if (!mounted.current) return;
        elapsedRef.current = { accum: 0, startedAt: 0 };
        setElapsedMs(0);
        setCountdownLeft(0);
        setPhaseSafe(ended || !displayLive(displayRef.current) ? "idle" : "armed");
      };

      recorderRef.current = recorder;
      elapsedRef.current = { accum: 0, startedAt: performance.now() };
      setElapsedMs(0);
      try {
        recorder.start(1000);
      } catch {
        recorder.start();
      }
      setCodec(chosen);
      setPhaseSafe("recording");
      startTicker();
    } catch (startError) {
      scaleStopRef.current?.();
      scaleStopRef.current = null;
      encodeMetaRef.current = null;
      if (mounted.current) {
        setError(startError instanceof Error ? startError.message : "Couldn't start the encoder.");
        setPhaseSafe(displayLive(displayRef.current) ? "armed" : "idle");
      }
    } finally {
      startingRef.current = false;
    }
  };

  const beginCountdown = () => {
    const token = ++countdownToken.current;
    const seconds = settingsRef.current.countdownSec;
    if (!seconds) {
      void startEncoder();
      return;
    }
    setPhaseSafe("countdown");
    setCountdownLeft(seconds);
    let left = seconds;
    countRef.current = window.setInterval(() => {
      if (countdownToken.current !== token) return;
      left -= 1;
      setCountdownLeft(Math.max(0, left));
      if (left <= 0) {
        clearCountdown();
        void startEncoder();
      }
    }, 1000);
  };

  const stop = () => {
    if (phaseRef.current === "countdown") {
      recordToken.current += 1;
      countdownToken.current += 1;
      clearCountdown();
      setCountdownLeft(0);
      setPhaseSafe(displayLive(displayRef.current) ? "armed" : "idle");
      return;
    }
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive" || stoppingRef.current) return;
    stoppingRef.current = true;
    const profile = resolveProfile(settingsRef.current);
    const shot = incomingRef.current;
    const meta = encodeMetaRef.current;
    pendingSave.current = {
      durationMs: frozenMs(),
      width: meta?.width || shot?.width || profile.width,
      height: meta?.height || shot?.height || profile.height,
      fps: meta?.fps || profile.fps,
      profileName: meta?.profileName || profile.name,
    };
    stopTicker();
    try {
      recorder.stop();
    } catch {
      stoppingRef.current = false;
      setPhaseSafe(displayLive(displayRef.current) ? "armed" : "idle");
      return;
    }
    if (phaseRef.current === "recording" || phaseRef.current === "paused") setPhaseSafe("saving");
  };

  const onPause = () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "recording" || stoppingRef.current) return;
    elapsedRef.current.accum += performance.now() - elapsedRef.current.startedAt;
    setElapsedMs(elapsedRef.current.accum);
    stopTicker();
    recorder.pause();
    setPhaseSafe("paused");
  };

  const onResume = () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "paused") return;
    elapsedRef.current.startedAt = performance.now();
    recorder.resume();
    setPhaseSafe("recording");
    startTicker();
  };

  const primeMixContext = () => {
    if (!audioRef.current || audioRef.current.state === "closed") audioRef.current = new AudioContext();
    void audioRef.current.resume();
  };

  const paintPip = (pipWin: Window, root: Root) => {
    root.render(
      <PipDeck
        phase={phaseRef.current}
        elapsedLabel={formatElapsed(elapsedRef.current, phaseRef.current)}
        countdownLeft={countdownLeft}
        onPrimary={() => {
          void actions.current.onRecord();
        }}
        onPauseToggle={() => {
          if (phaseRef.current === "recording") actions.current.onPause();
          else if (phaseRef.current === "paused") actions.current.onResume();
        }}
      />,
    );
    void pipWin;
  };

  const openPip = async (manual: boolean) => {
    const host = window.documentPictureInPicture;
    if (!host) {
      if (manual && mounted.current) setNotice("Floating controls need Chrome or Edge.");
      return;
    }
    if (host.window && pipRef.current) {
      host.window.focus();
      return;
    }
    const pipWin = await host.requestWindow({ width: 340, height: 212 });
    pipWin.document.title = "Nock";
    try {
      pipWin.document.adoptedStyleSheets = document.adoptedStyleSheets;
    } catch {
      /* Some browsers keep constructed sheets on the opener only. */
    }
    document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
      pipWin.document.head.appendChild(node.cloneNode(true));
    });
    const shell = document.querySelector(".nock-shell");
    const paint = getComputedStyle(shell ?? document.body);
    pipWin.document.body.style.margin = "0";
    pipWin.document.body.style.backgroundColor = paint.backgroundColor;
    pipWin.document.body.style.color = paint.color;
    pipWin.document.body.style.fontFamily = paint.fontFamily;
    const root = createRoot(pipWin.document.body);
    pipRef.current = { win: pipWin, root };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "F9") {
        event.preventDefault();
        void actions.current.onRecord();
      } else if (event.key === "F10") {
        event.preventDefault();
        if (phaseRef.current === "recording") actions.current.onPause();
        else if (phaseRef.current === "paused") actions.current.onResume();
      }
    };
    pipWin.addEventListener("keydown", onKey);
    pipWin.addEventListener("pagehide", () => {
      pipWin.removeEventListener("keydown", onKey);
      root.unmount();
      if (pipRef.current?.win === pipWin) pipRef.current = null;
      if (mounted.current) setPipOpen(false);
    });
    if (mounted.current) setPipOpen(true);
    paintPip(pipWin, root);
  };

  const onRecord = async () => {
    const current = phaseRef.current;
    if (current === "recording" || current === "paused") {
      stop();
      return;
    }
    if (current === "countdown") {
      stop();
      return;
    }
    if (current === "saving" || busyRef.current) return;
    busyRef.current = true;
    setError(null);
    try {
      const prefs = settingsRef.current;
      if (prefs.wantMic && prefs.wantSystemAudio) primeMixContext();
      if (!displayLive(displayRef.current)) {
        const ok = await acquire();
        if (!ok) {
          closeAudio();
          return;
        }
      }
      if (mounted.current && settingsRef.current.floatOnRecord) {
        await openPip(false).catch(() => undefined);
      }
      if (!mounted.current) return;
      beginCountdown();
    } finally {
      busyRef.current = false;
    }
  };

  const onChoose = async () => {
    if (busyRef.current) return;
    if (phaseRef.current === "countdown" || phaseRef.current === "recording" || phaseRef.current === "paused" || phaseRef.current === "saving") {
      return;
    }
    busyRef.current = true;
    setError(null);
    try {
      await acquire();
    } finally {
      busyRef.current = false;
    }
  };

  const setMicWanted = async (on: boolean) => {
    update({ wantMic: on });
    if (!on) {
      closeMic();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      update({ wantMic: false });
      setError("This browser has no microphone.");
      return;
    }
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: settingsRef.current.wantSystemAudio,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
      if (!mounted.current || !settingsRef.current.wantMic) {
        mic.getTracks().forEach((track) => track.stop());
        return;
      }
      closeMic();
      micRef.current = mic;
      setMicReady(true);
    } catch {
      if (!mounted.current) return;
      update({ wantMic: false });
      setMicReady(false);
      setError("Microphone permission was denied.");
    }
  };

  actions.current = { onRecord: () => void onRecord(), onPause, onResume };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recordToken.current += 1;
      countdownToken.current += 1;
      clearCountdown();
      stopTicker();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* Unmount is best-effort. */
        }
      }
      releaseDisplay();
      closeMic();
      closeAudio();
      pipRef.current?.root.unmount();
      try {
        pipRef.current?.win.close();
      } catch {
        /* Already closed. */
      }
      pipRef.current = null;
    };
    // Mount/unmount only. Helpers close over refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      const loaded = loadSettings(localStorage.getItem(STORAGE_KEY));
      settingsRef.current = loaded;
      setSettings(loaded);
    } catch {
      /* Keep defaults. */
    }
    setHydrated(true);
    setCodec(pickCodec(true));
    setGpuLabel(detectGpuLabel());
    setGpuChecked(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* Private mode. */
    }
  }, [settings, hydrated]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.key === "F9") {
        event.preventDefault();
        void actions.current.onRecord();
      } else if (event.key === "F10") {
        event.preventDefault();
        if (phaseRef.current === "recording") actions.current.onPause();
        else if (phaseRef.current === "paused") actions.current.onResume();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (phase !== "recording" && phase !== "paused") return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [phase]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const hide = settings.hidePreview && (phase === "recording" || phase === "paused" || phase === "saving");
    const stream = hide ? null : displayRef.current;
    if (element.srcObject !== stream) element.srcObject = stream;
    element.muted = true;
    if (stream) void element.play().catch(() => undefined);
  }, [phase, settings.hidePreview, previewEpoch]);

  useEffect(() => {
    const pip = pipRef.current;
    if (!pip || pip.win.closed) return;
    paintPip(pip.win, pip.root);
  });

  const resolved = resolveProfile(settings);
  const locked = phase === "countdown" || phase === "recording" || phase === "paused" || phase === "saving";
  const mirrorVisible = Boolean(incoming) && !(settings.hidePreview && (phase === "recording" || phase === "paused" || phase === "saving"));
  const withAudio = hasSystemAudio || (settings.wantMic && micReady);

  return {
    videoRef,
    settings,
    update,
    setMicWanted,
    phase,
    clips,
    activeClipId,
    setActiveClipId,
    removeClip,
    error,
    notice,
    clearNotice: () => setNotice(null),
    clearError: () => setError(null),
    elapsedMs,
    countdownLeft,
    codec,
    gpuLine: gpuHeadline(gpuLabel, gpuChecked),
    incoming,
    hasSystemAudio,
    micReady,
    pipOpen,
    mirrorVisible,
    resolved,
    locked,
    withAudio,
    onRecord,
    onChoose,
    onPause,
    onResume,
    openFloat: () => void openPip(true).catch(() => setNotice("The browser blocked the floating window. Click it again.")),
  };
}

function formatElapsed(clock: { accum: number; startedAt: number }, phase: Phase): string {
  const ms = phase === "recording" ? clock.accum + (performance.now() - clock.startedAt) : clock.accum;
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

export type { CountdownSec, CursorMode, ProfileId };
