import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Gerçek dosya türünü ilk baytlardan (magic bytes) tanır — istemcinin beyan ettiği `contentType`
 * başlığına güvenilmez (devam talimatı §2: "uzantısı MP4 olan her dosyanın oynatılacağını
 * varsayma"). Yalnızca bu modülün desteklediği türleri tanır; tanınmayan içerik `null` döner ve
 * çağıran yer bunu reddeder.
 */
const MAGIC: { type: string; check: (b: Buffer) => boolean }[] = [
  { type: "image/png", check: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: "image/jpeg", check: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/webp", check: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  { type: "image/gif", check: (b) => b.length > 6 && (b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a") },
  { type: "application/pdf", check: (b) => b.length > 4 && b.toString("ascii", 0, 4) === "%PDF" },
  // MP4/MOV/ISO-BMFF kapları: baytlar 4-8 "ftyp" olur (kutu boyutu + kutu türü).
  { type: "video/mp4", check: (b) => b.length > 12 && b.toString("ascii", 4, 8) === "ftyp" },
  // WebM/Matroska: EBML başlığı 0x1A45DFA3 ile başlar.
  { type: "video/webm", check: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
];

export function sniffContentType(buf: Buffer): string | null {
  for (const m of MAGIC) if (m.check(buf)) return m.type;
  return null;
}

/**
 * Videonun GERÇEK süresini ve codec'ini ffprobe ile ölçer (istemci beyanından değil, dosyanın
 * kendisinden — devam talimatı §2: "desteklenen codec listesini açıkça belirt"). ffprobe/ffmpeg
 * bu ortamda kurulu; üretim ortamında da kurulu olmalı (paket bağımlılığı olarak not edilir).
 * Dosya bozuksa veya ffprobe süreyi okuyamıyorsa `null` döner — çağıran yer bunu "geçersiz video"
 * olarak reddeder, süreyi uydurmaz.
 */
export async function probeVideo(filePath: string): Promise<{ durationSeconds: number; codec: string | null } | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_entries", "format=duration:stream=codec_name,codec_type", filePath],
      { timeout: 15000, maxBuffer: 1_000_000 },
    );
    const parsed = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; codec_name?: string }[] };
    const duration = Number(parsed.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    const videoStream = parsed.streams?.find((s) => s.codec_type === "video");
    return { durationSeconds: duration, codec: videoStream?.codec_name ?? null };
  } catch {
    return null;
  }
}

/** Desteklenen video codec'leri (H.264/H.265/VP8/VP9/AV1 — yaygın tarayıcı desteği olanlar). Liste açık tutulur, uydurulmaz. */
export const SUPPORTED_VIDEO_CODECS = ["h264", "hevc", "vp8", "vp9", "av1"] as const;
