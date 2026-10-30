/** Frame truth for re-shoot - the container's duration×fps over-counts when
 *  the audio runs past the last video frame (2.0 s video + 2.1 s audio @24
 *  reads 50 while the decode only yields 48), and the rig then indexes past
 *  the decoded batch. The video stream's own packet count is the real number
 *  of frames VHS_LoadVideo will produce.
 *
 *  probeClip = probeVideo (duration/fps/dims/rotation/audio - the container
 *  read stays authoritative for everything else) + a `-count_packets` pass
 *  on the video stream. Fallbacks when a codec won't report packets:
 *  nb_frames, then the STREAM's duration × its fps - never the container's. */
import { probeVideo, runBin, type ProbeInfo } from "@/lib/re-edit-ffmpeg";

const FFPROBE = () => process.env.FFPROBE_BIN || "ffprobe";

/** Inputs are always local files - same whitelist probeVideo applies so a
 *  crafted path can't make ffprobe reach out over the network. */
const FILE_ONLY = ["-protocol_whitelist", "file"];

export interface ClipProbe extends ProbeInfo {
  /** real decoded frame count - what the rig and the output will carry */
  frames: number;
}

interface StreamProbe {
  nb_read_packets?: string;
  nb_frames?: string;
  duration?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
}

const rateOf = (s: StreamProbe): number => {
  const rate = (s.avg_frame_rate && s.avg_frame_rate !== "0/0" ? s.avg_frame_rate : s.r_frame_rate) ?? "0/1";
  const [rn, rd] = rate.split("/").map(Number);
  return rd ? rn / rd : 0;
};

/** Real frame count of the video stream: packets → nb_frames → stream
 *  duration×fps → (last resort) the container estimate the caller had. */
async function countFrames(file: string, info: ProbeInfo): Promise<number> {
  try {
    const { stdout } = await runBin(FFPROBE(), [
      "-v", "error", "-select_streams", "v:0", "-count_packets",
      "-show_entries", "stream=nb_read_packets,nb_frames,duration,avg_frame_rate,r_frame_rate",
      "-print_format", "json", ...FILE_ONLY, "-i", file,
    ]);
    const s = (JSON.parse(stdout) as { streams?: StreamProbe[] }).streams?.[0];
    if (s) {
      const packets = Number(s.nb_read_packets);
      if (Number.isFinite(packets) && packets > 0) return Math.round(packets);
      const nb = Number(s.nb_frames);
      if (Number.isFinite(nb) && nb > 0) return Math.round(nb);
      const dur = Number(s.duration);
      const fps = rateOf(s) || info.fps;
      if (Number.isFinite(dur) && dur > 0) return Math.max(1, Math.round(dur * fps));
    }
  } catch {
    // a stream the probe can't read falls through to the container estimate
  }
  return Math.max(1, Math.round(info.durationSec * info.fps));
}

export async function probeClip(file: string): Promise<ClipProbe> {
  const info = await probeVideo(file);
  return { ...info, frames: await countFrames(file, info) };
}
