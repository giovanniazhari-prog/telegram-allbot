/**
 * Currency & Crypto Conversion Handler
 * Binance API (crypto) + fawazahmed0 (fiat)
 * Tidak butuh API key — semuanya gratis
 */

// ── Stablecoin ─────────────────────────────────────────────────────────────
const STABLECOINS = new Set(["USDT", "USDC", "BUSD", "DAI", "TUSD", "FDUSD", "USDP"]);

// ── Fiat yang didukung ─────────────────────────────────────────────────────
const FIAT_CURRENCIES = new Set([
    "USD","IDR","EUR","GBP","SGD","MYR","JPY","AUD","CNY","KRW","THB",
    "PHP","VND","INR","HKD","TWD","CHF","SEK","NOK","DKK","SAR","AED",
    "BRL","MXN","ZAR","TRY","PLN","CZK","HUF",
]);

// ── State: Binance symbols ─────────────────────────────────────────────────
let BINANCE_SYMBOLS = new Set();
let lastBinanceRefresh = 0;
const BINANCE_TTL = 60 * 60 * 1000; // 1 jam

// ── Fetch helpers ───────────────────────────────────────────────────────────
async function fetchJSON(url, timeout = 5000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// ── Load semua crypto symbols dari Binance ─────────────────────────────────
export async function loadBinanceSymbols() {
    try {
        const data = await fetchJSON("https://api.binance.us/api/v3/exchangeInfo");
        const symbols = new Set();
        for (const s of data.symbols || []) {
            if (s.status === "TRADING" && s.quoteAsset === "USDT") {
                symbols.add(s.baseAsset.toUpperCase());
            }
        }
        BINANCE_SYMBOLS = symbols;
        lastBinanceRefresh = Date.now();
        console.log(`✅ Loaded ${symbols.size} crypto symbols dari Binance`);
    } catch (e) {
        console.error("❌ Gagal load Binance symbols:", e.message);
    }
}

async function ensureBinanceSymbols() {
    if (BINANCE_SYMBOLS.size === 0 || Date.now() - lastBinanceRefresh > BINANCE_TTL) {
        await loadBinanceSymbols();
    }
}

// ── Deteksi tipe currency ───────────────────────────────────────────────────
function isFiat(sym) {
    return FIAT_CURRENCIES.has(sym.toUpperCase());
}

function isStablecoin(sym) {
    return STABLECOINS.has(sym.toUpperCase());
}

function isCrypto(sym) {
    const up = sym.toUpperCase();
    return BINANCE_SYMBOLS.has(up) || STABLECOINS.has(up);
}

// ── Ambil harga crypto dalam USDT dari Binance ─────────────────────────────
async function getCryptoPriceUsdt(symbol) {
    const up = symbol.toUpperCase();
    if (isStablecoin(up)) return 1;
    const data = await fetchJSON(`https://api.binance.us/api/v3/ticker/price?symbol=${up}USDT`);
    return parseFloat(data.price);
}

// ── Ambil rate fiat via fawazahmed0 ────────────────────────────────────────
async function getFiatRate(from, to) {
    const f = from.toLowerCase();
    const t = to.toLowerCase();
    const data = await fetchJSON(
        `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${f}.json`
    );
    const rate = data[f]?.[t];
    if (!rate) throw new Error(`Rate ${from}→${to} tidak ditemukan`);
    return rate;
}

// ── Format angka hasil konversi ─────────────────────────────────────────────
function formatResult(num) {
    if (!isFinite(num) || num <= 0) return null;

    if (num >= 1_000_000) {
        return num.toLocaleString("id-ID", { maximumFractionDigits: 0 });
    } else if (num >= 1_000) {
        return num.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else if (num >= 1) {
        return num.toLocaleString("id-ID", { minimumFractionDigits: 4, maximumFractionDigits: 4 }).replace(/\.?0+$/, "");
    } else {
        // < 1: sampai 8 desimal, trim trailing zeros
        return num.toFixed(8).replace(/\.?0+$/, "");
    }
}

// ── Pattern deteksi konversi ────────────────────────────────────────────────
// "[angka] [mata uang] to [mata uang]"
const CONVERSION_RE = /^([\d.,]+)\s+([a-zA-Z]{2,10})\s+to\s+([a-zA-Z]{2,10})$/i;

// "[angka] [token]" atau "[token]" saja → cek harga
// Contoh: "1 btc", "0.5 eth", "1,5 sol"
const PRICE_CHECK_RE = /^([\d.,]+\s+)?([a-zA-Z]{2,10})$/i;

export function isConversionMessage(text) {
    return CONVERSION_RE.test(text.trim());
}

export async function isPriceCheckMessage(text) {
    const t = text.trim();
    if (!PRICE_CHECK_RE.test(t)) return false;
    await ensureBinanceSymbols();
    const match = t.match(PRICE_CHECK_RE);
    const sym = match[2].toUpperCase();
    return isCrypto(sym) || isFiat(sym);
}

// ── Main: convert ───────────────────────────────────────────────────────────
export async function convertCurrency(text) {
    await ensureBinanceSymbols();

    const match = text.trim().match(CONVERSION_RE);
    if (!match) return null;

    // Normalisasi angka: koma desimal → titik
    const amountStr = match[1].replace(/,/g, ".");
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) return null;

    const fromSym = match[2].toUpperCase();
    const toSym   = match[3].toUpperCase();

    const fromIsFiat   = isFiat(fromSym);
    const toIsFiat     = isFiat(toSym);
    const fromIsCrypto = isCrypto(fromSym);
    const toIsCrypto   = isCrypto(toSym);

    // Harus kenal setidaknya salah satu
    if (!fromIsFiat && !fromIsCrypto) return null;
    if (!toIsFiat && !toIsCrypto) return null;

    let result;

    try {
        if (fromIsCrypto && toIsCrypto) {
            // Crypto → Crypto
            const priceA = await getCryptoPriceUsdt(fromSym);
            const priceB = await getCryptoPriceUsdt(toSym);
            result = amount * (priceA / priceB);

        } else if (fromIsCrypto && toIsFiat) {
            // Crypto → Fiat
            const priceUsdt = await getCryptoPriceUsdt(fromSym);
            const toUp = toSym.toUpperCase();
            if (toUp === "USD" || isStablecoin(toUp)) {
                result = amount * priceUsdt;
            } else {
                const usdToFiat = await getFiatRate("USD", toSym.toLowerCase());
                result = amount * priceUsdt * usdToFiat;
            }

        } else if (fromIsFiat && toIsCrypto) {
            // Fiat → Crypto
            const fromUp = fromSym.toUpperCase();
            let usdAmount;
            if (fromUp === "USD" || isStablecoin(fromUp)) {
                usdAmount = amount;
            } else {
                const fiatToUsd = await getFiatRate(fromSym.toLowerCase(), "usd");
                usdAmount = amount * fiatToUsd;
            }
            const priceUsdt = await getCryptoPriceUsdt(toSym);
            result = usdAmount / priceUsdt;

        } else {
            // Fiat → Fiat
            const rate = await getFiatRate(fromSym.toLowerCase(), toSym.toLowerCase());
            result = amount * rate;
        }

        if (!isFinite(result) || result <= 0) return null;

        const formatted = formatResult(result);
        if (!formatted) return null;

        // Format amount input
        const amountDisplay = amount % 1 === 0 ? amount.toLocaleString("id-ID") : amountStr;

        return {
            text: `💱 *${amountDisplay} ${fromSym}* = *${formatted} ${toSym}*`,
        };

    } catch (e) {
        console.error(`Currency conversion error: ${e.message}`);
        return null;
    }
}

// ── Simbol / emoji per crypto ───────────────────────────────────────────────
const CRYPTO_ICON = {
    BTC   : "₿",   ETH  : "Ξ",   BNB  : "🔶",  SOL  : "◎",
    XRP   : "✕",   ADA  : "₳",   DOGE : "Ð",   TRX  : "◈",
    TON   : "💎",  MATIC: "⬡",   DOT  : "●",   LTC  : "Ł",
    AVAX  : "🔺",  LINK : "⬡",   SHIB : "🐕",  PEPE : "🐸",
    UNI   : "🦄",  ATOM : "⚛",   XLM  : "✦",   FIL  : "⟠",
    APT   : "🔷",  ARB  : "🔵",  OP   : "🔴",  INJ  : "🌀",
    SUI   : "💧",  SEI  : "🔰",  WIF  : "🐕",  FLOKI: "⚡",
};

// ── Flag emoji per currency ─────────────────────────────────────────────────
const CURRENCY_FLAG = {
    USD: "🇺🇸", IDR: "🇮🇩", EUR: "🇪🇺", GBP: "🇬🇧", SGD: "🇸🇬",
    JPY: "🇯🇵", AUD: "🇦🇺", CNY: "🇨🇳", KRW: "🇰🇷", THB: "🇹🇭",
    PHP: "🇵🇭", MYR: "🇲🇾", CHF: "🇨🇭", SAR: "🇸🇦", AED: "🇦🇪",
    HKD: "🇭🇰", TWD: "🇹🇼", VND: "🇻🇳", INR: "🇮🇳", BRL: "🇧🇷",
    MXN: "🇲🇽", TRY: "🇹🇷", ZAR: "🇿🇦", SEK: "🇸🇪", NOK: "🇳🇴",
    DKK: "🇩🇰", PLN: "🇵🇱", CZK: "🇨🇿", HUF: "🇭🇺", NZD: "🇳🇿",
};

// ── 5 mata uang utama yang selalu ditampilkan ──────────────────────────────
const MAIN_CURRENCIES = ["USD", "IDR", "EUR", "GBP", "SGD"];

// Ambil semua rates sekaligus dari fawazahmed0 (satu request per base)
async function getUsdRates(targets) {
    const data = await fetchJSON(
        `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json`
    );
    const rates = {};
    for (const t of targets) {
        const r = data["usd"]?.[t.toLowerCase()];
        if (r) rates[t] = r;
    }
    return rates; // { IDR: 16200, EUR: 0.92, ... }
}

// ── Cek harga: "1 btc" / "1 usd" / "0.5 eth" / "btc" ─────────────────────
export async function checkPrice(text) {
    await ensureBinanceSymbols();

    const match = text.trim().match(PRICE_CHECK_RE);
    if (!match) return null;

    const amountStr = (match[1] || "1").trim().replace(/,/g, ".");
    const amount    = parseFloat(amountStr) || 1;
    const sym       = match[2].toUpperCase();

    const symIsCrypto = isCrypto(sym);
    const symIsFiat   = isFiat(sym);
    if (!symIsCrypto && !symIsFiat) return null;

    // Kode target: 5 main, kecuali mata uang itu sendiri (replace dgn yg berikutnya)
    const targets = MAIN_CURRENCIES.filter(c => c !== sym);
    // Kalau sym bukan di list, tetap 5; kalau sym ada di list, jadi 4 → tambah JPY
    if (MAIN_CURRENCIES.includes(sym)) targets.push("JPY");

    try {
        const amountDisplay = amount === 1
            ? "1"
            : Number.isInteger(amount)
                ? amount.toLocaleString("id-ID")
                : amountStr;

        const rows = []; // { flag, amount, code }

        if (symIsCrypto) {
            const priceUsdt = await getCryptoPriceUsdt(sym);
            const usdValue  = amount * priceUsdt;
            const usdRates  = await getUsdRates(targets.filter(t => t !== "USD"));

            for (const t of targets) {
                let converted;
                if (t === "USD") {
                    converted = usdValue;
                } else {
                    const rate = usdRates[t];
                    if (!rate) continue;
                    converted = usdValue * rate;
                }
                const fmt = formatResult(converted);
                if (fmt) rows.push({ flag: CURRENCY_FLAG[t] || "💱", fmt, code: t });
            }

        } else {
            const baseLower = sym.toLowerCase();
            const data = await fetchJSON(
                `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${baseLower}.json`
            );

            for (const t of targets) {
                const rate = data[baseLower]?.[t.toLowerCase()];
                if (!rate) continue;
                const converted = amount * rate;
                const fmt = formatResult(converted);
                if (fmt) rows.push({ flag: CURRENCY_FLAG[t] || "💱", fmt, code: t });
            }
        }

        if (!rows.length) return null;

        const symIcon = symIsCrypto
            ? (CRYPTO_ICON[sym] || "🪙")
            : (CURRENCY_FLAG[sym] || "💱");
        const lines = rows.map(r => `${r.flag}  ${r.fmt} ${r.code}`);

        return {
            text:
                `${symIcon} *${amountDisplay} ${sym}*\n` +
                `━━━━━━━━━━━━━━━\n` +
                lines.join("\n"),
        };

    } catch (e) {
        console.error(`Price check error [${sym}]: ${e.message}`);
        return null;
    }
}
