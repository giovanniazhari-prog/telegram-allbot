/**
   * Currency & Crypto Conversion Handler
   * CoinGecko API (crypto) + fawazahmed0 (fiat)
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

  // ── State: CoinGecko symbol map ────────────────────────────────────────────
  let COINGECKO_MAP = {};     // { "BTC": "bitcoin", "ETH": "ethereum", ... }
  let CRYPTO_SYMBOLS = new Set();
  let lastCoinGeckoRefresh = 0;
  const COINGECKO_TTL = 60 * 60 * 1000; // 1 jam

  // ── Fetch helpers ───────────────────────────────────────────────────────────
  async function fetchJSON(url, timeout = 8000) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
          const res = await fetch(url, {
              signal: ctrl.signal,
              headers: { "Accept": "application/json" },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.json();
      } finally {
          clearTimeout(timer);
      }
  }

  // ── Load top 500 crypto dari CoinGecko ─────────────────────────────────────
  export async function loadBinanceSymbols() {
      try {
          // Ambil top 500 coin berdasarkan market cap (2 halaman × 250)
          const [page1, page2] = await Promise.all([
              fetchJSON("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false", 12000),
              fetchJSON("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=2&sparkline=false", 12000),
          ]);

          const coins = [...(page1 || []), ...(page2 || [])];
          const map = {};
          const symbols = new Set();

          for (const coin of coins) {
              const sym = coin.symbol?.toUpperCase();
              if (!sym) continue;
              // Pakai yang pertama muncul (market cap tertinggi)
              if (!map[sym]) {
                  map[sym] = coin.id;
                  symbols.add(sym);
              }
          }

          // Tambahkan stablecoin manual jika belum ada
          const stableIds = { USDT: "tether", USDC: "usd-coin", DAI: "dai", BUSD: "binance-usd" };
          for (const [sym, id] of Object.entries(stableIds)) {
              if (!map[sym]) { map[sym] = id; symbols.add(sym); }
          }

          COINGECKO_MAP = map;
          CRYPTO_SYMBOLS = symbols;
          lastCoinGeckoRefresh = Date.now();
          console.log(`✅ Loaded ${symbols.size} crypto symbols dari CoinGecko`);
      } catch (e) {
          console.error("❌ Gagal load CoinGecko symbols:", e.message);
      }
  }

  async function ensureBinanceSymbols() {
      if (CRYPTO_SYMBOLS.size === 0 || Date.now() - lastCoinGeckoRefresh > COINGECKO_TTL) {
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
      return CRYPTO_SYMBOLS.has(up) || STABLECOINS.has(up);
  }

  // ── Ambil harga crypto dalam USD dari CoinGecko ────────────────────────────
  async function getCryptoPriceUsdt(symbol) {
      const up = symbol.toUpperCase();
      if (isStablecoin(up)) return 1;

      const coinId = COINGECKO_MAP[up];
      if (!coinId) throw new Error(`${symbol}: coin tidak ditemukan di CoinGecko`);

      const data = await fetchJSON(
          `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`
      );
      const price = data[coinId]?.usd;
      if (!price) throw new Error(`${symbol}: harga tidak tersedia`);
      return price;
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
          return num.toFixed(8).replace(/\.?0+$/, "");
      }
  }

  // ── Pattern deteksi konversi ────────────────────────────────────────────────
  const CONVERSION_RE = /^([\d.,]+)\s+([a-zA-Z]{2,10})\s+to\s+([a-zA-Z]{2,10})$/i;
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

      const amountStr = match[1].replace(/,/g, ".");
      const amount = parseFloat(amountStr);
      if (isNaN(amount) || amount <= 0) return null;

      const fromSym = match[2].toUpperCase();
      const toSym   = match[3].toUpperCase();

      const fromIsFiat   = isFiat(fromSym);
      const toIsFiat     = isFiat(toSym);
      const fromIsCrypto = isCrypto(fromSym);
      const toIsCrypto   = isCrypto(toSym);

      if (!fromIsFiat && !fromIsCrypto) return null;
      if (!toIsFiat && !toIsCrypto) return null;

      let result;

      try {
          if (fromIsCrypto && toIsCrypto) {
              const priceA = await getCryptoPriceUsdt(fromSym);
              const priceB = await getCryptoPriceUsdt(toSym);
              result = amount * (priceA / priceB);

          } else if (fromIsCrypto && toIsFiat) {
              const priceUsdt = await getCryptoPriceUsdt(fromSym);
              const toUp = toSym.toUpperCase();
              if (toUp === "USD" || isStablecoin(toUp)) {
                  result = amount * priceUsdt;
              } else {
                  const usdToFiat = await getFiatRate("USD", toSym.toLowerCase());
                  result = amount * priceUsdt * usdToFiat;
              }

          } else if (fromIsFiat && toIsCrypto) {
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
              const rate = await getFiatRate(fromSym.toLowerCase(), toSym.toLowerCase());
              result = amount * rate;
          }

          if (!isFinite(result) || result <= 0) return null;

          const formatted = formatResult(result);
          if (!formatted) return null;

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

  async function getUsdRates(targets) {
      const data = await fetchJSON(
          `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json`
      );
      const rates = {};
      for (const t of targets) {
          const r = data["usd"]?.[t.toLowerCase()];
          if (r) rates[t] = r;
      }
      return rates;
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

      const targets = MAIN_CURRENCIES.filter(c => c !== sym);
      if (MAIN_CURRENCIES.includes(sym)) targets.push("JPY");

      try {
          const amountDisplay = amount === 1
              ? "1"
              : Number.isInteger(amount)
                  ? amount.toLocaleString("id-ID")
                  : amountStr;

          const rows = [];

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
  