/**
 * Telegram All-in-One Bot
 *
 * Fitur:
 *  1. Auto-download video (kirim link YT/TikTok/IG/FB/Twitter/dll)
 *  2. /mp3 [link] — download audio MP3
 *  3. Math calculator (auto-detect ekspresi matematika)
 *  4. Currency & crypto converter (1 btc to idr)
 */

import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { Readable } from "stream";
import { execFile } from "child_process";
import { promisify } from "util";
import https from "https";
import http from "http";
import fs from "fs";
import { downloadVideo, downloadAudio, detectPlatform, fmtSize, cleanFile, getVideoTitle } from "./handlers/downloader.js";
import { isMathExpression, evaluateMath } from "./handlers/math.js";
import { isConversionMessage, convertCurrency, isPriceCheckMessage, checkPrice, loadBinanceSymbols } from "./handlers/currency.js";

const execFileAsync = promisify(execFile);

// ── Tulis cookies YouTube dari env var ke file temp ──────────────────────────
function setupYoutubeCookies() {
    const b64 = process.env.YOUTUBE_COOKIES_B64;
    if (!b64) {
        console.log("ℹ️  YOUTUBE_COOKIES_B64 tidak di-set, yt-dlp tanpa cookies");
        return;
    }
    try {
        const cookiesTxt = Buffer.from(b64, "base64").toString("utf-8");
        const cookiesPath = "/tmp/yt_cookies.txt";
        fs.writeFileSync(cookiesPath, cookiesTxt, { mode: 0o600 });
        process.env.YTDLP_COOKIES_FILE = cookiesPath;
        console.log("✅ YouTube cookies dimuat ke /tmp/yt_cookies.txt");
    } catch (e) {
        console.log(`⚠️  Gagal setup cookies: ${e.message}`);
    }
}

// ── Progress bar ─────────────────────────────────────────────────────────────
const BAR_LEN = 10;

function renderBar(pct) {
    const filled = Math.round((pct / 100) * BAR_LEN);
    return `${"▓".repeat(filled)}${"░".repeat(BAR_LEN - filled)} ${pct}%`;
}

// Animasi progress bar palsu — update pesan setiap beberapa detik
// Mengembalikan { stop } untuk menghentikan animasi
function startProgress(telegram, chatId, msgId) {
    // Step: [persen, delay_ms sebelum step berikutnya]
    const steps = [10, 25, 40, 55, 70, 85];
    let idx = 0;
    let stopped = false;
    let timer = null;

    function tick() {
        if (stopped || idx >= steps.length) return;
        const pct = steps[idx++];
        telegram.editMessageText(chatId, msgId, undefined, renderBar(pct)).catch(() => {});
        if (!stopped && idx < steps.length) {
            timer = setTimeout(tick, 3500);
        }
    }

    timer = setTimeout(tick, 1800);

    return {
        // done=true → tampilkan bar penuh + "Done!" lalu resolve
        stop: (done = false) => new Promise((resolve) => {
            stopped = true;
            if (timer) clearTimeout(timer);
            if (done) {
                telegram
                    .editMessageText(chatId, msgId, undefined, `${"▓".repeat(BAR_LEN)} Done!`)
                    .catch(() => {})
                    .finally(resolve);
            } else {
                resolve();
            }
        }),
    };
}

// ── Auto-update yt-dlp ke versi terbaru dari GitHub ─────────────────────────
async function updateYtDlp() {
    const dest = "/tmp/yt-dlp";
    const url  = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
    console.log("🔄 Mengunduh yt-dlp terbaru dari GitHub...");

    function downloadUrl(targetUrl, filePath, redirects = 8) {
        return new Promise((resolve, reject) => {
            if (redirects < 0) return reject(new Error("too many redirects"));
            const proto = targetUrl.startsWith("https") ? https : http;
            const file  = fs.createWriteStream(filePath);
            proto.get(targetUrl, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    file.close(); try { fs.unlinkSync(filePath); } catch (_) {}
                    return downloadUrl(res.headers.location, filePath, redirects - 1).then(resolve).catch(reject);
                }
                if (res.statusCode !== 200) {
                    file.close();
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                res.pipe(file);
                file.on("finish", () => file.close(resolve));
                file.on("error", reject);
            }).on("error", reject);
        });
    }

    try {
        await downloadUrl(url, dest);
        fs.chmodSync(dest, 0o755);
        const { stdout } = await execFileAsync(dest, ["--version"], { timeout: 10_000 });
        process.env.YTDLP_BIN = dest;
        console.log(`✅ yt-dlp ${stdout.trim()} siap (GitHub latest)`);
    } catch (e) {
        console.log(`⚠️  yt-dlp auto-update gagal: ${e.message?.slice(0, 80)}, pakai system yt-dlp`);
    }
}

// ── Ekstrak thumbnail dari video (frame di detik ke-2) ───────────────────────
async function extractThumbnail(videoFile) {
    const thumbFile = videoFile.replace(/(\.\w+)?$/, "_thumb.jpg");
    try {
        await execFileAsync("ffmpeg", [
            "-y", "-ss", "00:00:02", "-i", videoFile,
            "-vframes", "1", "-q:v", "2",
            "-vf", "scale=320:-2",
            thumbFile,
        ], { timeout: 15_000 });
        if (fs.existsSync(thumbFile) && fs.statSync(thumbFile).size > 500) {
            return thumbFile;
        }
    } catch (_) {}
    return null;
}

// ── Polyfill File global (dibutuhkan @tobyg74/tiktok-api-dl di Node.js < 20) ─
if (typeof globalThis.File === "undefined") {
    globalThis.File = class File {
        constructor(bits, name, options = {}) {
            this._bits = bits.map(b => Buffer.isBuffer(b) ? b : Buffer.from(b));
            this.name = name;
            this.type = options.type || "";
            this.lastModified = options.lastModified || Date.now();
            this.size = this._bits.reduce((a, b) => a + b.byteLength, 0);
        }
        async text() { return Buffer.concat(this._bits).toString(); }
        async arrayBuffer() { const buf = Buffer.concat(this._bits); return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); }
        stream() { return Readable.from(this._bits); }
    };
    console.log("ℹ️  File polyfill aktif (Node.js < 20)");
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
    console.error("❌ TELEGRAM_BOT_TOKEN belum di-set!");
    process.exit(1);
}

const bot = new Telegraf(TOKEN);

const URL_RE = /https?:\/\/[^\s]+/i;

// ── Regex link Telegram (t.me / telegram.me / telegram.dog) ─────────────────
const TELEGRAM_LINK_RE = /https?:\/\/(t\.me|telegram\.me|telegram\.dog)\//i;

// ── Helper: auto-delete pesan setelah N detik ────────────────────────────────
function autoDelete(ctx, messageId, delayMs = 60_000) {
    setTimeout(() => {
        ctx.telegram.deleteMessage(ctx.chat.id, messageId).catch(() => {});
    }, delayMs);
}

// ── /start ──────────────────────────────────────────────────────────────────
bot.start((ctx) => {
    ctx.reply(
`Halo! Ini bot serba bisa.

Download Video
Kirim link langsung — bot download & kirim video
Platform: YouTube, TikTok, Instagram, Facebook, Twitter/X, Reddit, Vimeo, dll

Download Audio MP3
/mp3 [link] — semua platform

Kalkulator Otomatis
Kirim ekspresi langsung, contoh:
  15.000 * 30
  (500+200) * 3
  sqrt(144)

Konversi Mata Uang & Crypto
Format: [angka] [kode] to [kode]
Contoh:
  1 btc to idr
  0.5 eth to usd
  100 usd to idr

/help untuk info lengkap`
    );
});

// ── /help ───────────────────────────────────────────────────────────────────
bot.help((ctx) => {
    ctx.reply(
`Platform download yang didukung:
- YouTube / YouTube Shorts
- TikTok
- Instagram Reels & Post
- Facebook
- Twitter / X
- Reddit, Vimeo, Dailymotion, dll

Crypto: Semua yang ada di Binance (BTC, ETH, SOL, PEPE, dll)

Fiat: USD, IDR, EUR, GBP, SGD, MYR, JPY, AUD, CNY, KRW, THB, PHP, VND, INR, HKD, TWD, CHF, SAR, AED, BRL, dll

/mp3 [link] — ekstrak audio dari semua platform`
    );
});

// ── /mp3 [link] ─────────────────────────────────────────────────────────────
bot.command("mp3", async (ctx) => {
    const args = ctx.message.text.replace(/^\/mp3\s*/i, "").trim();
    const urlMatch = args.match(URL_RE);

    if (!urlMatch) {
        return ctx.reply("Format: /mp3 [link video]\n\nContoh:\n  /mp3 https://youtu.be/xxx\n  /mp3 https://vt.tiktok.com/xxx");
    }

    const url = urlMatch[0];

    // Abaikan link Telegram
    if (TELEGRAM_LINK_RE.test(url)) return;

    const platform = detectPlatform(url);
    console.log(`🎵 [${ctx.from.id}] MP3: ${url.slice(0, 80)}`);

    const statusMsg = await ctx.reply(renderBar(0));
    const progress = startProgress(ctx.telegram, ctx.chat.id, statusMsg.message_id);

    let result = null;
    try {
        result = await downloadAudio(url);

        await progress.stop(true);
        await new Promise(r => setTimeout(r, 600));

        let title = "";
        try { title = await getVideoTitle(url); } catch (_) {}
        if (!title) title = platform.name + " Audio";

        await ctx.telegram.editMessageText(
            ctx.chat.id, statusMsg.message_id, undefined,
            `Mengirim audio...`
        );

        await ctx.replyWithAudio(
            { source: result.file },
            {
                title,
                caption: title,
            }
        );

        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
        console.log(`✅ MP3 terkirim ke [${ctx.from.id}]: ${title.slice(0, 40)}`);

    } catch (err) {
        console.error(`❌ MP3 gagal [${ctx.from.id}]: ${err.message}`);
        await progress.stop(false);
        await ctx.telegram.editMessageText(
            ctx.chat.id, statusMsg.message_id, undefined,
            `Gagal download audio.\n\n${err.message?.slice(0, 200)}`
        ).catch(() => ctx.reply(`Gagal: ${err.message?.slice(0, 200)}`));
    } finally {
        if (result?.file) cleanFile(result.file);
    }
});

// ── Handler pesan teks (video download + math + currency) ───────────────────
bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text) return;

    const hasUrl  = URL_RE.test(text);
    const isMath  = !hasUrl && isMathExpression(text);
    const isConv  = !hasUrl && !isMath && isConversionMessage(text);
    const isPrice = !hasUrl && !isMath && !isConv && await isPriceCheckMessage(text);

    // ── Download video (ada URL) ───────────────────────────────────────────
    if (hasUrl) {
        const url = text.match(URL_RE)[0];

        // Abaikan link Telegram diam-diam
        if (TELEGRAM_LINK_RE.test(url)) return;

        const platform = detectPlatform(url);
        console.log(`📩 [${ctx.from.id}] ${platform.name}: ${url.slice(0, 80)}`);

        const statusMsg = await ctx.reply(renderBar(0));
        const progress = startProgress(ctx.telegram, ctx.chat.id, statusMsg.message_id);

        let result = null;
        let thumbFile = null;
        try {
            result = await downloadVideo(url);

            await progress.stop(true);
            await new Promise(r => setTimeout(r, 600));

            let title = result.title || "";
            if (!title) {
                try { title = await getVideoTitle(url); } catch (_) {}
            }
            if (!title) title = platform.name + " Video";

            if (!result.isImage) {
                thumbFile = await extractThumbnail(result.file);
            }

            await ctx.telegram.editMessageText(
                ctx.chat.id, statusMsg.message_id, undefined,
                `${fmtSize(result.size)} - Mengirim video...`
            );

            await ctx.replyWithVideo(
                { source: result.file },
                {
                    caption: title,
                    supports_streaming: true,
                    ...(thumbFile ? { thumbnail: { source: fs.createReadStream(thumbFile) } } : {}),
                }
            );

            await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
            console.log(`✅ Video terkirim ke [${ctx.from.id}]: ${title.slice(0, 40)}`);

        } catch (err) {
            console.error(`❌ Video gagal [${ctx.from.id}]: ${err.message}`);
            await progress.stop(false);
            await ctx.telegram.editMessageText(
                ctx.chat.id, statusMsg.message_id, undefined,
                `Gagal download.\n\n${err.message?.slice(0, 200) || "Terjadi kesalahan."}`
            ).catch(() => ctx.reply(`Gagal: ${err.message?.slice(0, 200)}`));
        } finally {
            if (result?.file) cleanFile(result.file);
            if (thumbFile) cleanFile(thumbFile);
        }
        return;
    }

    // ── Math calculator ────────────────────────────────────────────────────
    if (isMath) {
        const res = evaluateMath(text);
        if (res) {
            console.log(`🧮 [${ctx.from.id}] ${text.slice(0, 40)} = ${res.num}`);
            await ctx.reply(`${res.expr} = ${res.result}`);
        }
        return;
    }

    // ── Currency / crypto conversion ───────────────────────────────────────
    if (isConv) {
        try {
            const res = await convertCurrency(text);
            if (res) {
                console.log(`💱 [${ctx.from.id}] ${text.slice(0, 40)}`);
                const sent = await ctx.reply(res.text, { parse_mode: "Markdown" });
                autoDelete(ctx, sent.message_id, 60_000);
            }
        } catch (e) {
            console.error(`Currency error: ${e.message}`);
        }
        return;
    }

    // ── Price check: "1 btc", "0.5 eth", dll ──────────────────────────────
    if (isPrice) {
        try {
            const res = await checkPrice(text);
            if (res) {
                console.log(`💰 [${ctx.from.id}] price check: ${text.slice(0, 20)}`);
                const sent = await ctx.reply(res.text, { parse_mode: "Markdown" });
                autoDelete(ctx, sent.message_id, 60_000);
            }
        } catch (e) {
            console.error(`Price check error: ${e.message}`);
        }
        return;
    }

    // ── Tidak cocok pattern apapun → diam ─────────────────────────────────
});

// ── Graceful shutdown ───────────────────────────────────────────────────────
process.once("SIGINT",  () => { console.log("Bot stopped (SIGINT)");  bot.stop("SIGINT");  });
process.once("SIGTERM", () => { console.log("Bot stopped (SIGTERM)"); bot.stop("SIGTERM"); });

// ── Init ─────────────────────────────────────────────────────────────────────
async function startBot() {
    setupYoutubeCookies();
    await updateYtDlp();

    console.log("⏳ Loading Binance symbols…");
    await loadBinanceSymbols();
    setInterval(loadBinanceSymbols, 60 * 60 * 1000);

    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log("✅ Webhook cleared, pending updates dropped");
    } catch (e) {
        console.log("⚠️  deleteWebhook:", e.message?.slice(0, 60));
    }

    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            await bot.launch({ dropPendingUpdates: true });
            console.log("🤖 Bot aktif!");
            return;
        } catch (err) {
            if (err.message?.includes("409") && attempt < 5) {
                const wait = attempt * 5000;
                console.log(`⚠️  409 Conflict (attempt ${attempt}), retry in ${wait / 1000}s…`);
                await new Promise(r => setTimeout(r, wait));
            } else {
                console.error("❌ Gagal start bot:", err.message);
                process.exit(1);
            }
        }
    }
}

startBot();
