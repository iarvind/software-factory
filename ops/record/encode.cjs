#!/usr/bin/env node
// Frames (from lib.cjs record()) → a full-speed MP4 in data/media and an edited GIF in docs/media.
// The edit is a list of segments between marks; each plays at a speed (2 = twice as fast) or is
// fitted into a number of seconds; time outside every segment is cut.
//
//   node ops/record/encode.cjs <frames dir> <edit.json>
//   edit.json: { "name": "board-live", "fps": 12, "colors": 128, "hold": 2,
//                "segments": [ { "from": "start", "to": "sent+1.5", "speed": 1 }, { "from": "sent+1.5", "to": "planned", "fit": 6 } ] }
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "..", "..");
const FFMPEG = process.env.FFMPEG || "ffmpeg";

function encode(dir, edit) {
  const { frames, marks } = JSON.parse(fs.readFileSync(path.join(dir, "frames.json"), "utf8"));
  if (!frames.length) throw new Error(`no frames in ${dir}`);
  const start = marks.find((m) => m.name === "start").t;
  const end = marks.findLast((m) => m.name === "end").t;
  const at = (ref) => {
    if (typeof ref === "number") return start + ref;
    const m = /^([\w.-]+?)([+-]\d+(?:\.\d+)?)?$/.exec(ref);
    const mk = m && marks.findLast((x) => x.name === m[1]);
    if (!mk) throw new Error(`no mark "${ref}" (have: ${marks.map((x) => x.name).join(", ")})`);
    return mk.t + Number(m[2] || 0);
  };
  // Frame i is on screen from its timestamp until the next frame's (the last one until "end").
  const shown = frames.map((f, i) => ({ file: f.file, a: f.t, b: i + 1 < frames.length ? frames[i + 1].t : Math.max(end, f.t + 0.04) }));
  const cut = (segments) => {
    const out = [];
    for (const s of segments) {
      const a = at(s.from), b = at(s.to);
      if (!(b > a)) throw new Error(`segment ${s.from} → ${s.to} is empty`);
      const speed = s.fit ? Math.max(s.minSpeed ?? 1, (b - a) / s.fit) : (s.speed ?? 1);
      for (const f of shown) {
        const d = (Math.min(b, f.b) - Math.max(a, f.a)) / speed;
        if (d <= 0) continue;
        const last = out[out.length - 1];
        if (last && last.file === f.file) last.d += d; else out.push({ file: f.file, d });
      }
      s._speed = speed; s._secs = (b - a) / speed;
    }
    return out;
  };
  // Resample onto the output frame grid: each output frame shows the source frame that was on screen then.
  const grid = (entries, fps) => {
    const out = [];
    const total = entries.reduce((sum, e) => sum + e.d, 0);
    let i = 0, end = entries[0].d;
    for (let k = 0; k * (1 / fps) < total; k++) {
      const t = k / fps;
      while (t >= end && i < entries.length - 1) end += entries[++i].d;
      const last = out[out.length - 1];
      if (last && last.file === entries[i].file) last.d += 1 / fps; else out.push({ file: entries[i].file, d: 1 / fps });
    }
    return out;
  };
  // One symlink per output frame, read back as an image sequence at exactly that rate. (The concat
  // demuxer, given the same timings as durations, came out several seconds longer than asked.)
  const sequence = (entries, fps, name) => {
    const seq = path.join(dir, `seq-${name}`);
    fs.rmSync(seq, { recursive: true, force: true });
    fs.mkdirSync(seq);
    let n = 0;
    for (const e of entries) for (let k = Math.round(e.d * fps); k > 0; k--) fs.symlinkSync(path.join(dir, e.file), path.join(seq, `s${String(n++).padStart(6, "0")}.png`));
    return { pattern: path.join(seq, "s%06d.png"), secs: n / fps };
  };
  const media = path.join(ROOT, "data", "media"), docs = path.join(ROOT, "docs", "media");
  fs.mkdirSync(media, { recursive: true }); fs.mkdirSync(docs, { recursive: true });

  // The source: every frame at its real timing.
  const raw = sequence(grid(cut([{ from: "start", to: "end", speed: 1 }]), 25), 25, "raw");
  const rawSecs = raw.secs;
  const mp4 = path.join(media, `${edit.name}.mp4`);
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-framerate", "25", "-i", raw.pattern, "-vf", "format=yuv420p", "-c:v", "libx264", "-crf", "18", "-preset", "slow", mp4]);

  // The edit.
  const segs = edit.segments.map((s) => ({ ...s }));
  const fps = edit.fps ?? 12, colors = edit.colors ?? 128;
  const edited = cut(segs);
  if (edit.hold) edited[edited.length - 1].d += edit.hold;
  const seq = sequence(grid(edited, fps), fps, "edit");
  const secs = seq.secs;
  const gif = path.join(docs, `${edit.name}.gif`);
  const scale = edit.width ? `,scale=${edit.width}:-1:flags=lanczos` : "";
  const dither = edit.dither ?? "none";
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(fps), "-i", seq.pattern,
    "-vf", `${scale ? scale.slice(1) + "," : ""}split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=${edit.stats ?? "full"}[p];[b][p]paletteuse=dither=${dither}:diff_mode=rectangle`,
    "-loop", "0", gif]);
  const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(2);
  console.log(`${edit.name}: source ${rawSecs.toFixed(1)} s → ${mp4} (${mb(mp4)} MB)`);
  for (const s of segs) console.log(`   ${String(s.from).padEnd(16)} → ${String(s.to).padEnd(16)} ×${s._speed.toFixed(2)}  ${s._secs.toFixed(1)} s`);
  console.log(`${edit.name}: GIF ${secs.toFixed(1)} s at ${fps} fps → ${gif} (${mb(gif)} MB)`);
  return { gif, mp4, secs };
}

module.exports = { encode };
if (require.main === module) {
  const [dir, editFile] = process.argv.slice(2);
  if (!dir || !editFile) { console.error("usage: node ops/record/encode.cjs <frames dir> <edit.json>"); process.exit(2); }
  encode(path.resolve(dir), JSON.parse(fs.readFileSync(editFile, "utf8")));
}
