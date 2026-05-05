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
import { downloadVideo, downloadAudio, detectPlatform, fmtSize, cleanFile, getVideoTitle } from "./handlers/downloader.js";
import { isMathExpression, evaluateMath } from "./handlers/math.js";
import { isConversionMessage, convertCurrency, isPriceCheckMessage, checkPrice, loadBinanceSymbols } from "./handlers/currency.js";

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

const URL_RE   = /https?:\/\/[^\s]+/i;
const MAX_VIDEO_MB = 50;
const MAX_AUDIO_MB = 50;

// ── /start ──────────────────────────────────────────────────────────────────
bot.start((ctx) => {
    ctx.reply(
`👋 Halo! Ini bot serba bisa.

📥 *Download Video*
Kirim link langsung → bot download & kirim video
Platform: YouTube, TikTok, Instagram, Facebook, Twitter/X, Reddit, Vimeo, dll

🎵 *Download Audio MP3*
/mp3 [link]

🧮 *Kalkulator Otomatis*
Kirim ekspresi langsung, contoh:
• \`15.000 * 30\`
• \`(500+200) * 3\`
• \`2^10\`
• \`sqrt(144)\`
• \`15000*30%\`

💱 *Konversi Mata Uang & Crypto*
Format: \`[angka] [kode] to [kode]\`
Contoh:
• \`1 btc to idr\`
• \`0.5 eth to usd\`
• \`100 usd to idr\`

/help untuk info lengkap`,
        { parse_mode: "Markdown" }
    );
});

// ── /help ───────────────────────────────────────────────────────────────────
bot.help((ctx) => {
    ctx.reply(
`*Platform download yang didukung:*
• YouTube / YouTube Shorts
• TikTok
• Instagram Reels & Post
• Facebook
• Twitter / X
• Reddit, Vimeo, Dailymotion, dll

*Crypto yang didukung:* Semua yang ada di Binance (BTC, ETH, SOL, PEPE, dll)

*Fiat yang didukung:*
USD, IDR, EUR, GBP, SGD, MYR, JPY, AUD, CNY, KRW, THB, PHP, VND, INR, HKD, TWD, CHF, SAR, AED, BRL, dll

*Batas ukuran video/audio:* 50 MB`,
        { parse_mode: "Markdown" }
    );
});

// ── /mp3 [link] ─────────────────────────────────────────────────────────────
bot.command("mp3", async (ctx) => {
    const args = ctx.message.text.replace(/^\/mp3\s*/i, "").trim();
    const urlMatch = args.match(URL_RE);

    if (!urlMatch) {
        return ctx.reply("⚠️ Format: /mp3 [link video]\nContoh: /mp3 https://youtu.be/xxx");
    }

    const url = urlMatch[0];
    const platform = detectPlatform(url);
    console.log(`🎵 [${ctx.from.id}] MP3: ${url.slice(0, 80)}`);

    const statusMsg = await ctx.reply(`${platform.emoji} Mengunduh audio dari *${platform.name}*...\n⏳ Harap tunggu!`, {
        parse_mode: "Markdown",
    });

    let result = null;
    try {
        result = await downloadAudio(url);

        if (result.size > MAX_AUDIO_MB * 1024 * 1024) {
            throw new Error(`File terlalu besar (${fmtSize(result.size)}, max ${MAX_AUDIO_MB}MB)`);
        }

        let title = "";
        try { title = await getVideoTitle(url); } catch (_) {}
        if (!title) title = platform.name + " Audio";

        await ctx.telegram.editMessageText(
            ctx.chat.id, statusMsg.message_id, undefined,
            `${platform.emoji} *${platform.name}*\n📦 Ukuran: ${fmtSize(result.size)}\n📤 Mengirim audio...`,
            { parse_mode: "Markdown" }
        );

        await ctx.replyWithAudio(
            { source: result.file },
            {
                title,
                caption: `🎵 *${title}*\n\n📥 Downloaded via bot`,
                parse_mode: "Markdown",
            }
        );

        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
        console.log(`✅ MP3 terkirim ke [${ctx.from.id}]: ${title.slice(0, 40)}`);

    } catch (err) {
        console.error(`❌ MP3 gagal [${ctx.from.id}]: ${err.message}`);
        await ctx.telegram.editMessageText(
            ctx.chat.id, statusMsg.message_id, undefined,
            `❌ *Gagal download audio!*\n\n${err.message?.slice(0, 200)}\n\n_Pastikan link benar dan video bisa diakses publik._`,
            { parse_mode: "Markdown" }
        ).catch(() => ctx.reply(`❌ Gagal: ${err.message?.slice(0, 200)}`));
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

    // ── 2. Download video (ada URL) ────────────────────────────────────────
    if (hasUrl) {
        const url = text.match(URL_RE)[0];
        const platform = detectPlatform(url);
        console.log(`📩 [${ctx.from.id}] ${platform.name}: ${url.slice(0, 80)}`);

        const statusMsg = await ctx.reply(
            `${platform.emoji} Mendeteksi *${platform.name}*...\n⏳ Sedang mengunduh video, harap tunggu!`,
            { parse_mode: "Markdown" }
        );

        let result = null;
        try {
            result = await downloadVideo(url, MAX_VIDEO_MB);

            await ctx.telegram.editMessageText(
                ctx.chat.id, statusMsg.message_id, undefined,
                `${platform.emoji} *${platform.name}*\n📦 Ukuran: ${fmtSize(result.size)}\n📤 Mengirim video...`,
                { parse_mode: "Markdown" }
            );

            let title = result.title || "";
            if (!title) {
                try { title = await getVideoTitle(url); } catch (_) {}
            }
            if (!title) title = platform.name + " Video";

            await ctx.replyWithVideo(
                { source: result.file },
                {
                    caption: `${platform.emoji} *${title}*\n\n📥 Downloaded via bot`,
                    parse_mode: "Markdown",
                    supports_streaming: true,
                }
            );

            await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
            console.log(`✅ Video terkirim ke [${ctx.from.id}]: ${title.slice(0, 40)}`);

        } catch (err) {
            console.error(`❌ Video gagal [${ctx.from.id}]: ${err.message}`);
            await ctx.telegram.editMessageText(
                ctx.chat.id, statusMsg.message_id, undefined,
                `❌ *Gagal download!*\n\n${err.message?.slice(0, 200) || "Terjadi kesalahan."}\n\n_Pastikan link benar dan video bisa diakses secara publik._`,
                { parse_mode: "Markdown" }
            ).catch(() => ctx.reply(`❌ Gagal: ${err.message?.slice(0, 200)}`));
        } finally {
            if (result?.file) cleanFile(result.file);
        }
        return;
    }

    // ── 3. Math calculator ─────────────────────────────────────────────────
    if (isMath) {
        const res = evaluateMath(text);
        if (res) {
            console.log(`🧮 [${ctx.from.id}] ${text.slice(0, 40)} = ${res.num}`);
            await ctx.reply(`🧮 \`${res.expr}\` = *${res.result}*`, {
                parse_mode: "Markdown",
            });
        }
        return;
    }

    // ── 4. Currency / crypto conversion ────────────────────────────────────
    if (isConv) {
        try {
            const res = await convertCurrency(text);
            if (res) {
                console.log(`💱 [${ctx.from.id}] ${text.slice(0, 40)}`);
                await ctx.reply(res.text, { parse_mode: "Markdown" });
            }
        } catch (e) {
            console.error(`Currency error: ${e.message}`);
        }
        return;
    }

    // ── 5. Price check: "1 btc", "0.5 eth", dll ───────────────────────────
    if (isPrice) {
        try {
            const res = await checkPrice(text);
            if (res) {
                console.log(`💰 [${ctx.from.id}] price check: ${text.slice(0, 20)}`);
                await ctx.reply(res.text, { parse_mode: "Markdown" });
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

// ── Init: hapus webhook + launch dengan retry ────────────────────────────────
async function startBot() {
    console.log("⏳ Loading Binance symbols…");
    await loadBinanceSymbols();
    setInterval(loadBinanceSymbols, 60 * 60 * 1000);

    // Hapus webhook & drop pending updates agar tidak 409 conflict antar deployment
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log("✅ Webhook cleared, pending updates dropped");
    } catch (e) {
        console.log("⚠️  deleteWebhook:", e.message?.slice(0, 60));
    }

    // Retry launch hingga 5x kalau 409 (deployment overlap)
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            await bot.launch({ dropPendingUpdates: true });
            console.log("🤖 Bot aktif! Semua fitur siap:");
            console.log("   📥 Video download (TikTok HD via tobyg74 v3)");
            console.log("   🎵 MP3 download (/mp3)");
            console.log("   🧮 Math calculator (auto-detect)");
            console.log("   💱 Currency/crypto converter (auto-detect)");
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
