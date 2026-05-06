/**
 * Downloader — multi-engine, prioritas HD
 * Diadaptasi dari azis-wa-bot untuk Telegram Bot
 *
 * TikTok    → @tobyg74/tiktok-api-dl v3 (HEVC 720p) | fallback: TikWM API | fallback: SnapTik
 * Instagram → yt-dlp primary
 * YouTube   → play-dl primary | fallback: yt-dlp
 * Facebook  → yt-dlp primary | fallback: GetFVid API
 * Twitter/X → yt-dlp primary | fallback: fxtwitter API
 * Lainnya   → yt-dlp universal (Reddit, Pinterest, Dailymotion, Vimeo, dll)
 */

import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { execFile } from "child_process";
import { promisify } from "util";
import playdl from "play-dl";

const execFileAsync = promisify(execFile);

// ── Antrian per platform (biar ga spam request) ─────────────────────────────
class PlatformQueue {
    constructor(cooldownMs = 1500) {
        this.queue      = [];
        this.running    = false;
        this.cooldownMs = cooldownMs;
    }

    add(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this._run();
        });
    }

    async _run() {
        if (this.running) return;
        this.running = true;
        while (this.queue.length) {
            const { fn, resolve, reject } = this.queue.shift();
            try   { resolve(await fn()); }
            catch (e) { reject(e); }
            if (this.queue.length) await new Promise(r => setTimeout(r, this.cooldownMs));
        }
        this.running = false;
    }
}

const queues = {
    tiktok   : new PlatformQueue(2000),
    instagram: new PlatformQueue(2000),
    youtube  : new PlatformQueue(2500),
    facebook : new PlatformQueue(2000),
    twitter  : new PlatformQueue(1500),
    generic  : new PlatformQueue(1500),
};

// ── Cache URL hasil download (10 menit) ────────────────────────────────────
const urlCache  = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function cacheGet(url) {
    const hit = urlCache.get(url);
    if (!hit) return null;
    if (Date.now() - hit.ts > CACHE_TTL) { urlCache.delete(url); return null; }
    if (!fs.existsSync(hit.result.file)) { urlCache.delete(url); return null; }
    return hit.result;
}

function cacheSet(url, result) {
    urlCache.set(url, { result, ts: Date.now() });
}

const TMP = "/tmp/tg_downloader";
fs.mkdirSync(TMP, { recursive: true });

export function tmpFile(ext) {
    return path.join(TMP, `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
}

export function cleanFile(...files) {
    for (const f of files) {
        try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
}

export function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const PLATFORM_MAP = [
    { re: /youtube\.com|youtu\.be/i,          name: "YouTube",     emoji: "🎬" },
    { re: /instagram\.com/i,                  name: "Instagram",   emoji: "📸" },
    { re: /tiktok\.com/i,                     name: "TikTok",      emoji: "🎵" },
    { re: /twitter\.com|x\.com/i,             name: "Twitter/X",   emoji: "🐦" },
    { re: /facebook\.com|fb\.com|fb\.watch/i, name: "Facebook",    emoji: "👥" },
    { re: /pinterest\.com/i,                  name: "Pinterest",   emoji: "📌" },
    { re: /reddit\.com/i,                     name: "Reddit",      emoji: "🤖" },
    { re: /dailymotion\.com/i,                name: "Dailymotion", emoji: "🎞️" },
    { re: /vimeo\.com/i,                      name: "Vimeo",       emoji: "🎥" },
];

export function detectPlatform(url) {
    for (const p of PLATFORM_MAP) if (p.re.test(url)) return p;
    return { name: "Website", emoji: "🌐" };
}

// ── HTTP downloader dengan redirect ─────────────────────────────────────���──
function downloadFromUrl(url, dest, redirects = 10, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        if (redirects < 0) return reject(new Error("too many redirects"));
        const proto = url.startsWith("https") ? https : http;
        const file  = fs.createWriteStream(dest);
        proto.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept"    : "video/mp4,video/*;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
                ...extraHeaders,
            }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close();
                try { fs.unlinkSync(dest); } catch (_) {}
                return downloadFromUrl(res.headers.location, dest, redirects - 1, extraHeaders).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                file.close();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            res.pipe(file);
            file.on("finish", () => file.close(resolve));
            file.on("error", reject);
        }).on("error", (err) => {
            try { fs.unlinkSync(dest); } catch (_) {}
            reject(err);
        });
    });
}

// ── yt-dlp core downloader ─────────────────────────────────────────────────
async function downloadWithYtDlp(url, extraArgs = []) {
    const prefix  = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const outTmpl = path.join(TMP, `${prefix}.%(ext)s`);

    const args = [
        "--no-playlist",
        "--socket-timeout", "30",
        "--retries", "3",
        "-f", "bestvideo[ext=mp4][vcodec!*=av01]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/mp4/best",
        "--merge-output-format", "mp4",
        "-o", outTmpl,
        ...extraArgs,
        url,
    ];

    console.log(`▶️  yt-dlp ${url.slice(0, 60)}…`);

    const ytdlpBin = process.env.YTDLP_BIN || "yt-dlp";
    try {
        const { stderr } = await execFileAsync(ytdlpBin, args, {
            timeout   : 120_000,
            maxBuffer : 20 * 1024 * 1024,
        });
        if (stderr) console.log("yt-dlp stderr:", stderr.slice(0, 300));
    } catch (err) {
        const msg = (err.stderr || err.message || "").slice(0, 800);
        throw new Error(`yt-dlp: ${msg}`);
    }

    const files = fs.readdirSync(TMP)
        .filter(f => f.startsWith(prefix))
        .map(f => path.join(TMP, f));

    if (!files.length) throw new Error("yt-dlp: tidak ada output file");

    const file = files[0];
    const stat = fs.statSync(file);
    if (stat.size === 0) throw new Error("yt-dlp: output file kosong");

    const ext = path.extname(file).slice(1) || "mp4";
    return { file, size: stat.size, ext, isImage: false };
}

// ── Cek apakah file video valid (bukan hitam/corrupt) ──────────────────────
async function isValidVideo(filePath) {
    try {
        const stat = fs.statSync(filePath);
        if (stat.size < 10_000) return false; // terlalu kecil, pasti invalid
        const { stdout } = await execFileAsync("ffprobe", [
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,width,height,duration",
            "-of", "json",
            filePath,
        ], { timeout: 15_000 });
        const info = JSON.parse(stdout || "{}");
        const stream = info?.streams?.[0];
        if (!stream) return false;
        const w = parseInt(stream.width || "0");
        const h = parseInt(stream.height || "0");
        return w > 0 && h > 0;
    } catch (_) {
        return true; // kalau ffprobe gagal, anggap valid
    }
}

// ── Resolve URL pendek (vt.tiktok.com, vm.tiktok.com, dll) ─���──────────────
async function resolveRedirect(url, maxRedirects = 8) {
    return new Promise((resolve) => {
        let redirectsLeft = maxRedirects;

        function follow(currentUrl) {
            if (redirectsLeft-- <= 0) return resolve(url); // fallback ke original
            const proto = currentUrl.startsWith("https") ? https : http;
            try {
                const req = proto.get(currentUrl, {
                    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
                }, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        const next = res.headers.location.startsWith("http")
                            ? res.headers.location
                            : new URL(res.headers.location, currentUrl).href;
                        res.resume();
                        follow(next);
                    } else {
                        res.resume();
                        resolve(currentUrl);
                    }
                });
                req.on("error", () => resolve(url));
                req.setTimeout(8000, () => { req.destroy(); resolve(url); });
            } catch (_) {
                resolve(url);
            }
        }

        follow(url);
    });
}

// ── TikTok Slideshow → gabungkan foto + audio jadi video ───────────────────
async function buildSlideshowVideo(d) {
    const images = Array.isArray(d.images) ? d.images : [];
    if (!images.length) throw new Error("Slideshow: tidak ada foto");

    const audioUrl = d.music || d.play;
    const imgFiles = [];

    console.log(`📸 Slideshow: ${images.length} foto, mulai download…`);

    // Download semua gambar
    for (let i = 0; i < images.length; i++) {
        const imgUrl  = typeof images[i] === "string" ? images[i] : images[i]?.url || images[i]?.download_url;
        if (!imgUrl) continue;
        const dest = path.join(TMP, `${Date.now()}_slide${i}.jpg`);
        try {
            await downloadFromUrl(imgUrl, dest, 8, { "Referer": "https://www.tiktok.com/" });
            const sz = fs.statSync(dest).size;
            if (sz > 1000) imgFiles.push(dest);
            else cleanFile(dest);
        } catch (e) {
            console.log(`⚠️  Slide ${i} gagal: ${e.message?.slice(0, 40)}`);
        }
    }

    if (!imgFiles.length) throw new Error("Slideshow: semua foto gagal didownload");

    // Download audio background
    const audioFile = path.join(TMP, `${Date.now()}_aud.mp3`);
    let hasAudio = false;
    if (audioUrl) {
        try {
            await downloadFromUrl(audioUrl, audioFile, 8, { "Referer": "https://www.tiktok.com/" });
            hasAudio = fs.statSync(audioFile).size > 1000;
        } catch (_) {}
    }

    // Ambil durasi audio asli pakai ffprobe
    async function getAudioDuration(filePath) {
        try {
            const { stdout } = await execFileAsync("ffprobe", [
                "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", filePath,
            ], { timeout: 10_000 });
            const dur = parseFloat(stdout.trim());
            return isFinite(dur) && dur > 0 ? dur : null;
        } catch (_) { return null; }
    }

    const PER_SLIDE = 3;
    let audioDur = hasAudio ? await getAudioDuration(audioFile) : null;

    // totalDur = durasi audio kalau lebih panjang dari foto × 3 detik
    // Ini penting untuk slideshow 1 foto dengan audio panjang
    const slidesDur = imgFiles.length * PER_SLIDE;
    const totalDur  = audioDur && audioDur > slidesDur ? Math.ceil(audioDur) : slidesDur;

    // Tiap foto tampil proporsional terhadap total durasi
    const perSlide  = totalDur / imgFiles.length;

    const listPath  = path.join(TMP, `${Date.now()}_list.txt`);
    const listLines = imgFiles.map(f => `file '${f}'\nduration ${perSlide.toFixed(3)}`);
    listLines.push(`file '${imgFiles[imgFiles.length - 1]}'`);
    fs.writeFileSync(listPath, listLines.join("\n"));

    console.log(`📸 Slideshow: ${imgFiles.length} foto × ${perSlide.toFixed(1)}s = ${totalDur}s total (audio: ${audioDur?.toFixed(1) ?? "n/a"}s)`);

    const outFile = path.join(TMP, `${Date.now()}_slideshow.mp4`);

    const ffArgs = ["-y", "-f", "concat", "-safe", "0", "-i", listPath];
    if (hasAudio) ffArgs.push("-stream_loop", "-1", "-i", audioFile);
    ffArgs.push(
        "-vf", "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=24",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast",
        "-t", String(totalDur),
    );
    if (hasAudio) ffArgs.push("-c:a", "aac", "-b:a", "128k");
    ffArgs.push(outFile);

    try {
        await execFileAsync("ffmpeg", ffArgs, { timeout: 120_000, maxBuffer: 50 * 1024 * 1024 });
    } finally {
        imgFiles.forEach(f => cleanFile(f));
        cleanFile(listPath, audioFile);
    }

    const stat = fs.statSync(outFile);
    if (stat.size < 10_000) throw new Error("Slideshow: output video kosong");

    const title = (d.title || "TikTok Slideshow").trim().slice(0, 80);
    console.log(`✅ TikTok slideshow → video (${imgFiles.length} foto)`);
    return { file: outFile, size: stat.size, ext: "mp4", isImage: false, title };
}

// ── Re-encode ke H.264 kalau codec tidak dikenal / AV1 (Telegram tidak support) ──
async function ensureH264(filePath) {
    try {
        const { stdout } = await execFileAsync("ffprobe", [
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name",
            "-of", "default=noprint_wrappers=1:nokey=1",
            filePath,
        ], { timeout: 15_000 });
        const codec = (stdout || "").trim().toLowerCase();
        // h264 dan h265 sudah aman untuk Telegram; codec kosong atau av1 → re-encode
        if (codec === "h264" || codec === "hevc" || codec === "h265") return filePath;
        console.log(`🔄 Codec "${codec || "unknown"}" tidak didukung Telegram, re-encode ke H.264…`);
    } catch (_) {
        return filePath; // ffprobe gagal, skip re-encode
    }

    const outFile = filePath.replace(/(\.\w+)?$/, "_h264.mp4");
    try {
        await execFileAsync("ffmpeg", [
            "-y", "-i", filePath,
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            outFile,
        ], { timeout: 120_000, maxBuffer: 50 * 1024 * 1024 });
        cleanFile(filePath);
        console.log(`✅ Re-encode selesai → ${path.basename(outFile)}`);
        return outFile;
    } catch (e) {
        console.log(`⚠️  Re-encode gagal: ${e.message?.slice(0, 80)}, pakai file asli`);
        try { cleanFile(outFile); } catch (_) {}
        return filePath;
    }
}

// ── Cek apakah URL ini adalah audio (bukan video) ───────────────────────────
async function isAudioUrl(url) {
    try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res   = await fetch(url, {
            method: "HEAD",
            signal: ctrl.signal,
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Referer"   : "https://www.tiktok.com/",
            },
        });
        clearTimeout(timer);
        const ct = res.headers.get("content-type") || "";
        return ct.includes("audio") && !ct.includes("video");
    } catch (_) {
        return false;
    }
}

// ── TikTok → beberapa API fallback ─────────────────────────────────────────
async function downloadTikTokViaTikWM(url) {
    const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer"   : "https://www.tikwm.com/",
            "Accept"    : "application/json",
        },
    });
    const data = await res.json();
    if (!data?.data) throw new Error("TikWM: respons kosong");

    const d = data.data;

    // ── Deteksi slideshow (foto + audio) ──────────────────────────────────
    if (Array.isArray(d.images) && d.images.length > 0) {
        console.log("📸 TikTok slideshow terdeteksi, membuat video…");
        return await buildSlideshowVideo(d);
    }

    if (!d.play && !d.wmplay) throw new Error("TikWM: tidak ada URL video");

    // hdplay = bvc2 (codec proprietary ByteDance, tidak ada decoder) → skip total
    // play = H.264 no watermark | wmplay = H.264 bitrate lebih tinggi (ada watermark)
    const urls = [d.play, d.wmplay].filter(Boolean);

    for (const videoUrl of urls) {
        try {
            // Skip URL yang content-type-nya audio (bukan video)
            if (await isAudioUrl(videoUrl)) {
                console.log("⚠️  TikWM URL adalah audio, skip…");
                continue;
            }

            const dest = path.join(TMP, `${Date.now()}.mp4`);
            await downloadFromUrl(videoUrl, dest, 10, {
                "Referer": "https://www.tiktok.com/",
                "Origin" : "https://www.tiktok.com",
            });
            const stat = fs.statSync(dest);
            if (stat.size < 10_000) { cleanFile(dest); continue; }

            const valid = await isValidVideo(dest);
            if (!valid) {
                console.log(`⚠️  TikWM url menghasilkan video invalid, coba url lain…`);
                cleanFile(dest);
                continue;
            }

            const title = (d.title || "").trim().slice(0, 80) || null;
            console.log("✅ TikTok via TikWM");
            return { file: dest, size: stat.size, ext: "mp4", isImage: false, title };
        } catch (e) {
            console.log(`⚠️  TikWM url gagal: ${e.message?.slice(0, 60)}`);
        }
    }
    throw new Error("TikWM: semua URL gagal atau video invalid");
}

// ── TikTok → @tobyg74/tiktok-api-dl v3 (HEVC 720p HD) ─────────────────────
let _tiktokDL = null;
async function getTiktokDL() {
    if (_tiktokDL) return _tiktokDL;
    const m = await import("@tobyg74/tiktok-api-dl");
    _tiktokDL = m.Downloader || m.default?.Downloader;
    return _tiktokDL;
}

async function downloadTikTokViaTobyg74(url) {
    const Downloader = await getTiktokDL();
    if (typeof Downloader !== "function") throw new Error("tobyg74: Downloader bukan function");

    const result = await Downloader(url, { version: "v3" });
    if (result?.status !== "success") throw new Error(`tobyg74: status ${result?.status}`);

    const r = result.result;
    if (!r) throw new Error("tobyg74: result kosong");

    // Slideshow (foto + audio)
    if (r.type === "image" && Array.isArray(r.images) && r.images.length > 0) {
        const tikwmFmt = {
            images: r.images.map(i => (typeof i === "string" ? i : i?.url || i?.download_url)),
            music: r.music?.play_url || null,
            title: r.desc || "",
        };
        console.log("📸 tobyg74: slideshow terdeteksi, pakai buildSlideshowVideo…");
        return await buildSlideshowVideo(tikwmFmt);
    }

    // Video: coba videoHD dulu (HEVC 720p), fallback videoSD (H.264 576p)
    const candidates = [r.videoHD, r.videoSD].filter(Boolean);
    if (!candidates.length) throw new Error("tobyg74: tidak ada URL video");

    for (const videoUrl of candidates) {
        try {
            const dest = path.join(TMP, `${Date.now()}.mp4`);
            await downloadFromUrl(videoUrl, dest, 10, {
                "Referer": "https://www.tiktok.com/",
            });
            const stat = fs.statSync(dest);
            if (stat.size < 10_000) { cleanFile(dest); continue; }
            const valid = await isValidVideo(dest);
            if (!valid) { cleanFile(dest); continue; }
            const title = (r.desc || "").trim().slice(0, 80) || null;
            const isHD = videoUrl === r.videoHD;
            console.log(`✅ TikTok via tobyg74 (${isHD ? "HEVC 720p" : "SD"})`);
            return { file: dest, size: stat.size, ext: "mp4", isImage: false, title };
        } catch (e) {
            console.log(`⚠️  tobyg74 url gagal: ${e.message?.slice(0, 60)}`);
        }
    }
    throw new Error("tobyg74: semua URL gagal");
}

async function downloadTikTokViaSnapTik(url) {
    // SnapTik API (unofficial, gratis)
    const apiUrl = `https://snaptik.app/abc2.php`;
    const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent"  : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer"     : "https://snaptik.app/",
        },
        body: `url=${encodeURIComponent(url)}`,
    });
    const html = await res.text();
    // Cari URL MP4 dari response HTML
    const matches = [...html.matchAll(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/gi)];
    if (!matches.length) throw new Error("SnapTik: tidak ada URL video");

    for (const m of matches.slice(0, 3)) {
        try {
            const videoUrl = m[0].replace(/&amp;/g, "&");
            const dest = path.join(TMP, `${Date.now()}.mp4`);
            await downloadFromUrl(videoUrl, dest, 10, { "Referer": "https://snaptik.app/" });
            const stat = fs.statSync(dest);
            if (stat.size < 10_000) { cleanFile(dest); continue; }
            const valid = await isValidVideo(dest);
            if (!valid) { cleanFile(dest); continue; }
            console.log("✅ TikTok via SnapTik");
            return { file: dest, size: stat.size, ext: "mp4", isImage: false };
        } catch (_) {}
    }
    throw new Error("SnapTik: semua URL gagal");
}

async function downloadTikTok(url) {
    // PRIMARY: tobyg74 v3 — HEVC 720p HD (bekerja dari IP manapun via API pihak ketiga)
    try {
        return await downloadTikTokViaTobyg74(url);
    } catch (e) {
        console.log(`⚠️  tobyg74 gagal (${e.message?.slice(0, 80)}), fallback TikWM…`);
    }

    // FALLBACK 1: TikWM — H.264 576p, no watermark
    try {
        return await downloadTikTokViaTikWM(url);
    } catch (e) {
        console.log(`⚠️  TikWM gagal (${e.message?.slice(0, 80)}), fallback SnapTik…`);
    }

    // FALLBACK 2: SnapTik
    try {
        return await downloadTikTokViaSnapTik(url);
    } catch (e) {
        throw new Error(`TikTok gagal didownload dari semua sumber: ${e.message?.slice(0, 100)}`);
    }
}

// ── Instagram → yt-dlp ─────────────────────────────────────────────────────

// ── YouTube-specific yt-dlp: cap 480p, tanpa max-filesize, timeout 5 menit ──
async function downloadWithYtDlpYouTube(url) {
    const prefix  = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const outTmpl = path.join(TMP, `${prefix}.%(ext)s`);

    const args = [
        "--no-playlist",
        "--socket-timeout", "60",
        "--retries", "5",
        "-f", "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]/best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "-o", outTmpl,
        url,
    ];

    console.log(`▶️  yt-dlp YouTube (≤480p) ${url.slice(0, 60)}…`);

    const ytdlpBin = process.env.YTDLP_BIN || "yt-dlp";
    try {
        const { stderr } = await execFileAsync(ytdlpBin, args, {
            timeout   : 300_000,
            maxBuffer : 20 * 1024 * 1024,
        });
        if (stderr) console.log("yt-dlp YouTube stderr:", stderr.slice(0, 300));
    } catch (err) {
        const msg = (err.stderr || err.message || "").slice(0, 400);
        throw new Error(`yt-dlp: ${msg}`);
    }

    const files = fs.readdirSync(TMP)
        .filter(f => f.startsWith(prefix))
        .map(f => path.join(TMP, f));

    if (!files.length) throw new Error("yt-dlp: tidak ada output file");

    const file = files[0];
    const stat  = fs.statSync(file);
    if (stat.size === 0) throw new Error("yt-dlp: output file kosong");

    const ext = path.extname(file).slice(1) || "mp4";
    return { file, size: stat.size, ext, isImage: false };
}

async function downloadInstagram(url) {
    try {
        const result = await downloadWithYtDlp(url);
        console.log("✅ Instagram via yt-dlp");
        return result;
    } catch (e) {
        throw new Error(`Instagram gagal didownload: ${e.message?.slice(0, 100)}`);
    }
}

// ── YouTube → play-dl primary + fallback yt-dlp ────────────────────────────
function normalizeYTUrl(url) {
    const shorts = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shorts) return `https://www.youtube.com/watch?v=${shorts[1]}`;
    const short = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (short) return `https://www.youtube.com/watch?v=${short[1]}`;
    return url;
}

async function downloadYouTube(url) {
    const normalUrl = normalizeYTUrl(url);

    try {
        const info = await playdl.video_info(normalUrl);
        if (info?.format?.length) {
            const formats = info.format.filter(f => f.url);
            const mp4     = formats.filter(f => f.mimeType?.includes("mp4"));
            const picked  =
                mp4.find(f => f.quality?.includes("360")) ||
                mp4.find(f => f.quality?.includes("480")) ||
                mp4.find(f => f.quality?.includes("720")) ||
                mp4[0] || formats[0];

            if (picked?.url) {
                console.log(`▶️  YouTube play-dl: [${picked.quality || "?"}]`);
                const dest = path.join(TMP, `${Date.now()}.mp4`);
                await downloadFromUrl(picked.url, dest);
                const stat = fs.statSync(dest);
                if (stat.size > 0) return { file: dest, size: stat.size, ext: "mp4", isImage: false };
            }
        }
    } catch (e) {
        console.log(`⚠️  YouTube play-dl gagal (${e.message?.slice(0, 60)}), fallback yt-dlp…`);
    }

    console.log("▶️  YouTube yt-dlp fallback (≤480p, max 5min)…");
    return await downloadWithYtDlpYouTube(normalUrl);
}

// ── Facebook → yt-dlp ──────────────────────────────────────────────────────
async function downloadFacebook(url) {
    try {
        return await downloadWithYtDlp(url);
    } catch (e) {
        throw new Error(`Facebook gagal didownload: ${e.message?.slice(0, 100)}`);
    }
}

// ── Twitter/X → yt-dlp + fallback fxtwitter ────────────────────────────────
async function downloadTwitter(url) {
    try {
        return await downloadWithYtDlp(url);
    } catch (e) {
        console.log(`⚠️  Twitter yt-dlp gagal (${e.message?.slice(0, 80)}), coba fxtwitter…`);
    }

    try {
        const tweetId = url.match(/status\/(\d+)/)?.[1];
        if (!tweetId) throw new Error("Twitter: tweet ID tidak ditemukan");

        const apiUrl = `https://api.fxtwitter.com/status/${tweetId}`;
        const res    = await fetch(apiUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
        const data   = await res.json();

        const media = data?.tweet?.media?.videos?.[0] || data?.tweet?.media?.photos?.[0];
        if (!media) throw new Error("fxtwitter: tidak ada media");

        const videoUrl = media.url;
        if (!videoUrl) throw new Error("fxtwitter: tidak ada URL video");

        const isImg = !!data?.tweet?.media?.photos?.[0] && !data?.tweet?.media?.videos?.[0];
        const ext   = isImg ? "jpg" : "mp4";
        const dest  = path.join(TMP, `${Date.now()}.${ext}`);
        await downloadFromUrl(videoUrl, dest);
        const stat = fs.statSync(dest);
        if (stat.size === 0) throw new Error("fxtwitter: file kosong");
        console.log("✅ Twitter via fxtwitter");
        return { file: dest, size: stat.size, ext, isImage: isImg };
    } catch (e) {
        throw new Error(`Twitter/X gagal didownload: ${e.message?.slice(0, 100)}`);
    }
}

// ── Generic (Reddit, Pinterest, Vimeo, dll) ────────────────────────────────
async function downloadGeneric(url) {
    try {
        return await downloadWithYtDlp(url);
    } catch (e) {
        throw new Error(`Gagal download dari URL ini: ${e.message?.slice(0, 100)}`);
    }
}

// ── Main: downloadVideo ─────────────────────────────────────────────────────
export async function downloadVideo(url) {
    const cached = cacheGet(url);
    if (cached) {
        console.log(`✅ Cache hit: ${url.slice(0, 60)}`);
        return cached;
    }

    let queueKey, fn;
    if      (/tiktok\.com/i.test(url))                     { queueKey = "tiktok";    fn = () => downloadTikTok(url);    }
    else if (/instagram\.com/i.test(url))                  { queueKey = "instagram"; fn = () => downloadInstagram(url); }
    else if (/youtube\.com|youtu\.be/i.test(url))          { queueKey = "youtube";   fn = () => downloadYouTube(url);   }
    else if (/facebook\.com|fb\.com|fb\.watch/i.test(url)) { queueKey = "facebook";  fn = () => downloadFacebook(url);  }
    else if (/twitter\.com|x\.com/i.test(url))             { queueKey = "twitter";   fn = () => downloadTwitter(url);   }
    else                                                    { queueKey = "generic";   fn = () => downloadGeneric(url);   }

    const result = await queues[queueKey].add(fn);


    cacheSet(url, result);
    return result;
}

// ── getVideoTitle ──────────────────────────────────────────────────────────
async function getTitleYtDlp(url) {
    const ytdlpBin = process.env.YTDLP_BIN || "yt-dlp";
    try {
        const { stdout } = await execFileAsync(ytdlpBin, [
            "--no-playlist", "--print", "title", "--skip-download", url,
        ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
        return (stdout || "").trim().slice(0, 60) || "Video";
    } catch (_) {
        return "Video";
    }
}

export async function getVideoTitle(url) {
    const isYoutube = /youtube\.com|youtu\.be/i.test(url);
    if (isYoutube) {
        try {
            const info = await playdl.video_info(normalizeYTUrl(url));
            const title = info?.video_details?.title;
            if (title) return title.slice(0, 60);
        } catch (_) {}
    }
    return await getTitleYtDlp(url);
}

// ── downloadAudio: semua platform via yt-dlp → mp3 ────────────────────────
export async function downloadAudio(url) {
    const prefix  = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const outTmpl = path.join(TMP, `${prefix}.%(ext)s`);

    const isYoutube = /youtube\.com|youtu\.be/i.test(url);
    const normalUrl = isYoutube ? normalizeYTUrl(url) : url;

    // Coba play-dl untuk YouTube (lebih cepat)
    if (isYoutube) {
        try {
            const info = await playdl.video_info(normalUrl);
            if (info?.format?.length) {
                const audioFmt = info.format
                    .filter(f => f.url && (f.mimeType?.includes("audio") || f.hasAudio))
                    .sort((a, b) => (parseInt(b.audioBitrate) || 0) - (parseInt(a.audioBitrate) || 0))[0]
                    || info.format.filter(f => f.url)[0];

                if (audioFmt?.url) {
                    const rawDest = tmpFile("mp4");
                    await downloadFromUrl(audioFmt.url, rawDest);
                    const stat = fs.statSync(rawDest);
                    if (stat.size > 0) {
                        // Convert ke mp3 pakai ffmpeg
                        const mp3Dest = rawDest.replace(/\.\w+$/, ".mp3");
                        try {
                            await execFileAsync("ffmpeg", [
                                "-y", "-i", rawDest,
                                "-vn", "-ar", "44100", "-ac", "2", "-b:a", "192k",
                                mp3Dest,
                            ], { timeout: 120_000 });
                            cleanFile(rawDest);
                            const mp3Stat = fs.statSync(mp3Dest);
                            if (mp3Stat.size > 0) {
                                return { file: mp3Dest, size: mp3Stat.size };
                            }
                        } catch (_) {
                            cleanFile(rawDest);
                        }
                    }
                }
            }
        } catch (e) {
            console.log(`⚠️  YouTube play-dl audio gagal, fallback yt-dlp…`);
        }
    }

    // yt-dlp extract audio → mp3
    const ytdlpBin = process.env.YTDLP_BIN || "yt-dlp";
    try {
        await execFileAsync(ytdlpBin, [
            "--no-playlist",
            "--socket-timeout", "30",
            "--retries", "3",
            "-x",
            "--audio-format", "mp3",
            "--audio-quality", "0",
            "-o", outTmpl,
            normalUrl,
        ], { timeout: 300_000, maxBuffer: 20 * 1024 * 1024 });
    } catch (err) {
        const msg = (err.stderr || err.message || "").slice(0, 800);
        throw new Error(`yt-dlp audio: ${msg}`);
    }

    const files = fs.readdirSync(TMP).filter(f => f.startsWith(prefix));
    if (!files.length) throw new Error("yt-dlp audio: tidak ada output file");

    const file = path.join(TMP, files[0]);
    const stat = fs.statSync(file);
    if (stat.size === 0) throw new Error("yt-dlp audio: file kosong");
    return { file, size: stat.size };
}

// Cleanup file lama tiap 30 menit
setInterval(() => {
    try {
        const now = Date.now();
        fs.readdirSync(TMP).forEach(f => {
            const fp = path.join(TMP, f);
            try {
                if (now - fs.statSync(fp).mtimeMs > 30 * 60 * 1000) fs.unlinkSync(fp);
            } catch (_) {}
        });
    } catch (_) {}
}, 30 * 60 * 1000);
