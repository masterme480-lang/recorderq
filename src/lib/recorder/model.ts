export const STORAGE_KEY = "nock-settings-v1";

export const PROFILES = [
  {
    id: "feather",
    name: "Feather",
    blurb: "Lightest, when a game already fills the chip.",
    width: 960,
    height: 540,
    fps: 30,
    videoBitsPerSecond: 2_400_000,
    recommended: false,
  },
  {
    id: "smooth",
    name: "Smooth",
    blurb: "Best match for Intel HD Graphics 520.",
    width: 1280,
    height: 720,
    fps: 30,
    videoBitsPerSecond: 4_500_000,
    recommended: true,
  },
  {
    id: "balanced",
    name: "Balanced",
    blurb: "Clearer picture, still inside a light laptop.",
    width: 1280,
    height: 720,
    fps: 30,
    videoBitsPerSecond: 6_500_000,
    recommended: false,
  },
  {
    id: "crisp",
    name: "Crisp",
    blurb: "1080p. Fine for apps. A 3D game may hitch.",
    width: 1920,
    height: 1080,
    fps: 30,
    videoBitsPerSecond: 8_000_000,
    recommended: false,
  },
] as const;

export type ProfileId = (typeof PROFILES)[number]["id"];
export type Profile = {
  id: ProfileId;
  name: string;
  blurb: string;
  width: number;
  height: number;
  fps: number;
  videoBitsPerSecond: number;
  recommended: boolean;
};
export type CursorMode = "motion" | "always" | "never";
export type CountdownSec = 0 | 3 | 5;

export type Settings = {
  profileId: ProfileId;
  highFrameRate: boolean;
  wantMic: boolean;
  wantSystemAudio: boolean;
  hidePreview: boolean;
  countdownSec: CountdownSec;
  autoDownload: boolean;
  cursor: CursorMode;
  floatOnRecord: boolean;
};

export const defaultSettings: Settings = {
  profileId: "smooth",
  highFrameRate: false,
  wantMic: false,
  wantSystemAudio: true,
  hidePreview: true,
  countdownSec: 3,
  autoDownload: true,
  cursor: "motion",
  floatOnRecord: true,
};

export type Incoming = {
  width: number;
  height: number;
  fps: number;
  surface: string;
};

export type Clip = {
  id: string;
  url: string;
  blob: Blob;
  name: string;
  createdAt: number;
  durationMs: number;
  bytes: number;
  mime: string;
  width: number;
  height: number;
  fps: number;
  profileName: string;
  codecLabel: string;
};

export type CodecChoice = {
  mime: string;
  ext: "mp4" | "webm";
  label: string;
  hardwareLikely: boolean;
};

type CodecCandidate = CodecChoice;

const WITH_AUDIO: CodecCandidate[] = [
  { mime: 'video/mp4;codecs="avc1.4D401F,mp4a.40.2"', ext: "mp4", label: "H.264", hardwareLikely: true },
  { mime: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', ext: "mp4", label: "H.264", hardwareLikely: true },
  { mime: 'video/webm;codecs="h264,opus"', ext: "webm", label: "H.264", hardwareLikely: true },
  { mime: 'video/webm;codecs="vp8,opus"', ext: "webm", label: "VP8", hardwareLikely: false },
  { mime: 'video/webm;codecs="vp9,opus"', ext: "webm", label: "VP9", hardwareLikely: false },
  { mime: "video/webm", ext: "webm", label: "WebM", hardwareLikely: false },
];

const VIDEO_ONLY: CodecCandidate[] = [
  { mime: 'video/mp4;codecs="avc1.4D401F"', ext: "mp4", label: "H.264", hardwareLikely: true },
  { mime: 'video/mp4;codecs="avc1.42E01E"', ext: "mp4", label: "H.264", hardwareLikely: true },
  { mime: 'video/webm;codecs="h264"', ext: "webm", label: "H.264", hardwareLikely: true },
  { mime: 'video/webm;codecs="vp8"', ext: "webm", label: "VP8", hardwareLikely: false },
  { mime: "video/webm", ext: "webm", label: "WebM", hardwareLikely: false },
];

const FALLBACK_CODEC: CodecChoice = {
  mime: "",
  ext: "webm",
  label: "Browser default",
  hardwareLikely: false,
};

export function pickCodec(hasAudio: boolean): CodecChoice {
  if (typeof MediaRecorder === "undefined") return FALLBACK_CODEC;
  const list = hasAudio ? WITH_AUDIO : VIDEO_ONLY;
  for (const candidate of list) {
    if (MediaRecorder.isTypeSupported(candidate.mime)) return candidate;
  }
  return FALLBACK_CODEC;
}

export function labelFromMime(mime: string): string {
  if (/avc1|h264|mp4/i.test(mime)) return "H.264";
  if (/vp8/i.test(mime)) return "VP8";
  if (/vp9/i.test(mime)) return "VP9";
  if (/webm/i.test(mime)) return "WebM";
  return "Video";
}

export function resolveProfile(settings: Settings): Profile {
  const base = PROFILES.find((profile) => profile.id === settings.profileId) ?? PROFILES[1];
  if (!settings.highFrameRate) return base;
  return {
    ...base,
    fps: 60,
    videoBitsPerSecond: Math.round(base.videoBitsPerSecond * 1.45),
  };
}

export function profileDetail(profile: Pick<Profile, "height" | "fps" | "videoBitsPerSecond">): string {
  return `${profile.height}p · ${profile.fps} fps · ${formatRate(profile.videoBitsPerSecond)}`;
}

export function formatRate(bitsPerSecond: number): string {
  const mbps = bitsPerSecond / 1_000_000;
  return `${mbps.toFixed(1)} Mbps`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => value.toString().padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

export function estimateBytes(videoBits: number, withAudio: boolean, ms: number): number {
  const audioBits = withAudio ? 96_000 : 0;
  return Math.round(((videoBits + audioBits) / 8) * (ms / 1000));
}

export function surfaceName(surface: string): string {
  if (surface === "monitor") return "Entire screen";
  if (surface === "window") return "Window";
  if (surface === "browser") return "Tab";
  return "Source";
}

export function clipFilename(ext: string, when = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `Nock-${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}.${ext}`;
}

export function extFromMime(mime: string, fallback: "mp4" | "webm"): "mp4" | "webm" {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("webm")) return "webm";
  return fallback;
}

export function humanizeCaptureError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "AbortError") {
    return "Capture was cancelled. Choose a screen or window when the browser asks.";
  }
  if (name === "NotFoundError") return "No screen or window was available to record.";
  if (name === "NotReadableError") {
    return "The screen is busy in another recorder. Close that and try again.";
  }
  if (name === "SecurityError" || name === "NotSupportedError") {
    return "Screen recording isn't available here. Open Nock in Chrome or Edge on your PC.";
  }
  if (error instanceof Error && error.message) return error.message;
  return "Couldn't start capture.";
}

export function gpuHeadline(label: string | null, checked: boolean): string {
  if (!checked) return "Tuned for Intel HD Graphics 520. Leave Smooth on unless the game stutters.";
  if (!label) return "The browser didn't share a GPU name. Smooth is still the HD 520 default.";
  if (/intel/i.test(label) && /520/.test(label)) {
    return `This PC reports ${shortGpu(label)}. Smooth matches that chip.`;
  }
  if (/intel/i.test(label)) {
    return `This PC reports ${shortGpu(label)}. Light profiles fit Intel graphics like the HD 520.`;
  }
  return `This PC reports ${shortGpu(label)}. Smooth is aimed at Intel HD 520 and stays light here too.`;
}

function shortGpu(label: string): string {
  const cleaned = label.replace(/^ANGLE\s*\(/i, "").replace(/\)\s*$/, "");
  const intel = cleaned.split(",")[1]?.trim();
  return intel || cleaned;
}

export function detectGpuLabel(): string | null {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl", { powerPreference: "low-power" });
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof renderer === "string" && renderer.trim() ? renderer.trim() : null;
  } catch {
    return null;
  }
}

function isProfileId(value: unknown): value is ProfileId {
  return PROFILES.some((profile) => profile.id === value);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function loadSettings(raw: string | null): Settings {
  if (!raw) return { ...defaultSettings };
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof Settings, unknown>>;
    const countdown = parsed.countdownSec;
    const cursor = parsed.cursor;
    return {
      profileId: isProfileId(parsed.profileId) ? parsed.profileId : defaultSettings.profileId,
      highFrameRate: bool(parsed.highFrameRate, defaultSettings.highFrameRate),
      wantMic: bool(parsed.wantMic, defaultSettings.wantMic),
      wantSystemAudio: bool(parsed.wantSystemAudio, defaultSettings.wantSystemAudio),
      hidePreview: bool(parsed.hidePreview, defaultSettings.hidePreview),
      countdownSec: countdown === 0 || countdown === 3 || countdown === 5 ? countdown : defaultSettings.countdownSec,
      autoDownload: bool(parsed.autoDownload, defaultSettings.autoDownload),
      cursor: cursor === "always" || cursor === "never" || cursor === "motion" ? cursor : defaultSettings.cursor,
      floatOnRecord: bool(parsed.floatOnRecord, defaultSettings.floatOnRecord),
    };
  } catch {
    return { ...defaultSettings };
  }
}

export function sourceIsHeavy(incoming: Incoming, profile: Profile): boolean {
  return (
    incoming.width > profile.width * 1.2 ||
    incoming.height > profile.height * 1.2 ||
    (incoming.fps > 0 && incoming.fps > profile.fps + 5)
  );
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4_000);
}
