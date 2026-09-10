import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_VIDEO_BYTES } from "./sourceGrab.js";

export interface VideoProbe {
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  bitRate: number;
  codec: string;
}

export interface EnhancementPlan {
  apply: boolean;
  targetWidth: number;
  targetHeight: number;
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
  denoise: boolean;
  sharpen: number;
  reason: string;
}

interface VideoLike {
  name: string;
  mime: string;
  buffer: Buffer;
}

type StepLog = (text: string) => void;

const number = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

function frameRate(value: unknown): number {
  const raw = String(value || "");
  const match = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(raw);
  if (match) {
    const denominator = number(match[2]);
    return denominator ? number(match[1]) / denominator : 0;
  }
  return number(raw);
}

/** Pure policy: low-resolution/low-bitrate/dark clips get a high-quality master. */
export function planVideoEnhancement(probe: VideoProbe, averageLuma: number | null): EnhancementPlan {
  const portrait = probe.height >= probe.width;
  const targetWidth = portrait ? 1080 : 1920;
  const targetHeight = portrait ? 1920 : 1080;
  const shortSide = Math.min(probe.width, probe.height);
  const longSide = Math.max(probe.width, probe.height);
  const lowResolution = shortSide < 1000 || longSide < 1800;
  const lowBitrate = probe.bitRate > 0 && probe.bitRate < 3_500_000;
  const incompatibleCodec = probe.codec.toLowerCase() !== "h264";
  const luma = averageLuma ?? 116;
  let brightness = 0;
  let gamma = 1;
  if (luma < 65) {
    brightness = 0.08;
    gamma = 1.16;
  } else if (luma < 90) {
    brightness = 0.055;
    gamma = 1.1;
  } else if (luma < 112) {
    brightness = 0.025;
    gamma = 1.05;
  } else if (luma > 195) {
    brightness = -0.015;
    gamma = 0.98;
  }
  const lighting = Math.abs(brightness) > 0.001;
  const apply = lowResolution || lowBitrate || incompatibleCodec || lighting;
  const reasons = [
    lowResolution ? `${probe.width}×${probe.height} is below a 1080p master` : "",
    lowBitrate ? `${(probe.bitRate / 1_000_000).toFixed(1)} Mbps source bitrate is soft` : "",
    incompatibleCodec ? `${probe.codec || "unknown"} needs a platform-safe H.264 master` : "",
    lighting ? `measured luma ${Math.round(luma)} needs exposure correction` : "",
  ].filter(Boolean);
  return {
    apply,
    targetWidth,
    targetHeight,
    brightness,
    contrast: luma < 75 ? 1.05 : 1.08,
    saturation: luma < 75 ? 1.08 : 1.1,
    gamma,
    denoise: lowResolution || lowBitrate,
    sharpen: lowResolution ? 0.72 : 0.42,
    reason: reasons.join("; ") || "source is already sharp, bright, and at least 1080p",
  };
}

interface RunResult {
  stdout: Buffer;
  stderr: string;
}

async function run(
  command: string,
  args: string[],
  options: { timeoutMs: number; captureStdout?: boolean; maxStdout?: number }
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", options.captureStdout ? "pipe" : "ignore", "pipe"] });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${Math.round(options.timeoutMs / 1000)}s`));
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= (options.maxStdout ?? 1_000_000)) stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-12_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(-700) || "no diagnostic"}`));
    });
  });
}

async function probeVideo(file: string): Promise<VideoProbe> {
  const result = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate,bit_rate,codec_name:format=duration,bit_rate",
      "-of",
      "json",
      file,
    ],
    { timeoutMs: 30_000, captureStdout: true, maxStdout: 128_000 }
  );
  const parsed = JSON.parse(result.stdout.toString("utf8")) as {
    streams?: Array<{ width?: unknown; height?: unknown; r_frame_rate?: unknown; bit_rate?: unknown; codec_name?: unknown }>;
    format?: { duration?: unknown; bit_rate?: unknown };
  };
  const stream = parsed.streams?.[0];
  const width = number(stream?.width);
  const height = number(stream?.height);
  if (!width || !height) throw new Error("ffprobe found no usable video stream");
  return {
    width,
    height,
    duration: number(parsed.format?.duration),
    frameRate: frameRate(stream?.r_frame_rate),
    bitRate: number(stream?.bit_rate) || number(parsed.format?.bit_rate),
    codec: String(stream?.codec_name || "unknown"),
  };
}

async function sampleLuma(file: string, duration: number): Promise<number | null> {
  const points = duration >= 4 ? [duration * 0.22, duration * 0.63] : [0];
  const frames = await Promise.all(
    points.map(async (at) => {
      const result = await run(
        "ffmpeg",
        [
          "-v",
          "error",
          "-ss",
          at.toFixed(3),
          "-i",
          file,
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-vf",
          "scale=64:64:flags=area,format=gray",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        { timeoutMs: 45_000, captureStdout: true, maxStdout: 16_384 }
      );
      return result.stdout;
    })
  );
  let total = 0;
  let count = 0;
  for (const frame of frames) {
    for (const value of frame) {
      total += value;
      count += 1;
    }
  }
  return count ? total / count : null;
}

function filterGraph(plan: EnhancementPlan): string {
  const corrections = [
    plan.denoise ? "hqdn3d=1.0:1.0:3.5:3.5" : "null",
    `eq=brightness=${plan.brightness.toFixed(3)}:contrast=${plan.contrast.toFixed(3)}:saturation=${plan.saturation.toFixed(3)}:gamma=${plan.gamma.toFixed(3)}`,
    `unsharp=5:5:${plan.sharpen.toFixed(2)}:5:5:0`,
  ].join(",");
  const { targetWidth: width, targetHeight: height } = plan;
  // A non-9:16 clip gets a softly blurred full-frame background instead of ugly
  // black bars; the foreground is never cropped. Exact 9:16 footage fills it.
  return (
    `[0:v]${corrections},split=2[base][front];` +
    `[base]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},gblur=sigma=28[bg];` +
    `[front]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1,setsar=1,format=yuv420p[v]`
  );
}

export function discoveryQualityRejection(probe: VideoProbe, bytes: number): string | null {
  const shortSide = Math.min(probe.width, probe.height);
  const longSide = Math.max(probe.width, probe.height);
  if (bytes < 500_000) return `source is only ${(bytes / 1024).toFixed(0)} KB`;
  if (shortSide < 700 || longSide < 1200) return `source is ${probe.width}×${probe.height}; discovery requires at least 720p-class detail`;
  if (probe.duration > 0 && (probe.duration < 2 || probe.duration > 180)) {
    return `source duration ${probe.duration.toFixed(1)}s is outside the 2–180s short-video quality window`;
  }
  if (probe.frameRate > 0 && probe.frameRate < 20) return `source frame rate ${probe.frameRate.toFixed(1)} fps is too low`;
  if (probe.bitRate > 0 && probe.bitRate < 1_200_000) return `source bitrate ${(probe.bitRate / 1_000_000).toFixed(1)} Mbps is too soft`;
  return null;
}

/** Parse Tesseract TSV and identify common platform/creator watermark marks. */
export function watermarkFromTsv(tsv: string): string | null {
  const words: string[] = [];
  for (const line of tsv.split(/\r?\n/).slice(1)) {
    const cols = line.split("\t");
    if (cols.length < 12) continue;
    const confidence = Number(cols[10]);
    const text = cols.slice(11).join("\t").trim();
    if (text && (!Number.isFinite(confidence) || confidence >= 25)) words.push(text);
  }
  const joined = words.join(" ").replace(/\s+/g, " ").trim();
  const branded = joined.match(/\b(?:tiktok|capcut|instagram|youtube\s*shorts?|made\s+with)\b/i);
  if (branded) return branded[0];
  const handle = joined.match(/(?:^|\s)@\s*[a-z0-9_.-]{3,}/i);
  if (handle) return handle[0].trim();
  return null;
}

async function scanVisibleWatermark(file: string, probe: VideoProbe, dir: string): Promise<string | null> {
  const duration = probe.duration || 3;
  const points = [duration * 0.18, duration * 0.51, duration * 0.82];
  for (let index = 0; index < points.length; index += 1) {
    const frame = path.join(dir, `watermark-${index}.png`);
    await run(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-ss",
        points[index].toFixed(3),
        "-i",
        file,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        "scale='min(1280,iw)':-2:flags=lanczos",
        frame,
      ],
      { timeoutMs: 45_000 }
    );
    const ocr = await run("tesseract", [frame, "stdout", "-l", "eng", "--psm", "11", "tsv"], {
      timeoutMs: 45_000,
      captureStdout: true,
      maxStdout: 2_000_000,
    });
    const mark = watermarkFromTsv(ocr.stdout.toString("utf8"));
    if (mark) return mark;
  }
  return null;
}

/**
 * Discovery is stricter than a user-supplied link: reject soft footage and scan
 * sampled pixels for platform/creator marks before any caption or upload begins.
 */
export async function screenVideoForDiscovery<T extends VideoLike>(video: T, log: StepLog): Promise<VideoProbe> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "viraldeck-screen-"));
  const input = path.join(dir, "candidate.mp4");
  try {
    await fs.writeFile(input, video.buffer);
    const probe = await probeVideo(input);
    const quality = discoveryQualityRejection(probe, video.buffer.length);
    if (quality) throw new Error(`quality screen rejected it: ${quality}`);
    const watermark = await scanVisibleWatermark(input, probe, dir);
    if (watermark) throw new Error(`visible watermark screen found “${watermark}”`);
    log(
      `✅ Candidate screen passed: ${probe.width}×${probe.height}, ` +
        `${probe.frameRate ? `${probe.frameRate.toFixed(1)} fps, ` : ""}` +
        `${probe.bitRate ? `${(probe.bitRate / 1_000_000).toFixed(1)} Mbps, ` : ""}no detected platform/creator watermark.`
    );
    return probe;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Build a clean 1080p upload master when the source actually needs it. This is
 * deliberately before every platform uploader, so TikTok, Instagram and YouTube
 * all receive the same inspected, exposure-corrected file.
 */
export async function enhanceVideoForUpload<T extends VideoLike>(video: T, log: StepLog): Promise<T> {
  const mode = (process.env.VD_VIDEO_ENHANCE || "adaptive").trim().toLowerCase();
  if (["0", "false", "off", "none"].includes(mode)) {
    log("Video enhancement disabled by VD_VIDEO_ENHANCE — preserving source bytes.");
    return video;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "viraldeck-hq-"));
  const input = path.join(dir, "source.mp4");
  const output = path.join(dir, "upload-master.mp4");
  try {
    await fs.writeFile(input, video.buffer);
    const probe = await probeVideo(input);
    const luma = await sampleLuma(input, probe.duration).catch(() => null);
    const plan = planVideoEnhancement(probe, luma);
    const fps = probe.frameRate ? `${probe.frameRate.toFixed(2)} fps, ` : "";
    const bitrate = probe.bitRate ? `${(probe.bitRate / 1_000_000).toFixed(1)} Mbps, ` : "";
    log(
      `Source quality inspected: ${probe.width}×${probe.height}, ${fps}${bitrate}${probe.codec}` +
        `${luma === null ? "" : `, luma ${Math.round(luma)}`}.`
    );
    if (!plan.apply && mode !== "always") {
      log("✅ Source is already 1080p-quality with balanced exposure — preserving it without generation loss.");
      return video;
    }
    if (mode === "always" && !plan.apply) plan.reason = "strong enhancement requested for every clip";
    log(
      `Enhancing upload master to ${plan.targetWidth}×${plan.targetHeight}: ${plan.reason}; ` +
        `high-quality H.264, exposure/color recovery, denoise and detail sharpening…`
    );
    const timeoutPin = Number(process.env.VD_ENHANCE_TIMEOUT_MIN || 12);
    const timeoutMin = Number.isFinite(timeoutPin) ? Math.min(60, Math.max(2, timeoutPin)) : 12;
    await run(
      "ffmpeg",
      [
        "-y",
        "-v",
        "warning",
        "-i",
        input,
        "-filter_complex",
        filterGraph(plan),
        "-map",
        "[v]",
        "-map",
        "0:a:0?",
        "-map_metadata",
        "-1",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "16",
        "-maxrate",
        "14M",
        "-bufsize",
        "28M",
        "-profile:v",
        "high",
        "-level:v",
        "4.2",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        "-shortest",
        "-max_muxing_queue_size",
        "2048",
        output,
      ],
      { timeoutMs: timeoutMin * 60_000 }
    );
    const mastered = await probeVideo(output);
    if (mastered.width !== plan.targetWidth || mastered.height !== plan.targetHeight) {
      throw new Error(
        `enhanced dimensions are ${mastered.width}×${mastered.height}, expected ${plan.targetWidth}×${plan.targetHeight}`
      );
    }
    if (probe.duration > 1 && Math.abs(mastered.duration - probe.duration) > 1.5) {
      throw new Error(
        `enhanced duration changed from ${probe.duration.toFixed(1)}s to ${mastered.duration.toFixed(1)}s`
      );
    }
    const buffer = await fs.readFile(output);
    if (buffer.length < 100_000) throw new Error(`enhanced file is only ${buffer.length} bytes`);
    if (buffer.length > MAX_VIDEO_BYTES) {
      throw new Error(
        `enhanced upload is ${(buffer.length / 1_048_576).toFixed(0)} MB — over the ${(MAX_VIDEO_BYTES / 1_048_576).toFixed(0)} MB safety cap`
      );
    }
    const stem = video.name.replace(/\.[^.]+$/, "").slice(0, 80) || "clip";
    log(
      `✅ Enhanced master ready (${(buffer.length / 1_048_576).toFixed(1)} MB, ${plan.targetWidth}×${plan.targetHeight}, CRF 16).`
    );
    return { ...video, name: `${stem}-hq.mp4`, mime: "video/mp4", buffer };
  } catch (error) {
    throw new Error(
      `Video quality enhancement failed before upload: ${(error as Error).message}. Nothing was posted at the old quality.`
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
