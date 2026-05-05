/**
 * Math Calculator Handler
 * Safe math expression detection & evaluation
 */

import { create, all } from "mathjs";

// Satu math instance yang aman — whitelist regex sudah jadi penjaga utama
const math = create(all, {});

// ── Regex ───────────────────────────────────────────────────────────────────
const HAS_OPERATOR   = /[+\-*\/\^×÷%]/;
const SAFE_EXPR_RE   = /^[0-9+\-*\/^×÷%().√sqrtSQRT\s,._]+$/;

function hasLettersExceptSqrt(str) {
    return /[a-zA-Z]/.test(str.replace(/sqrt/gi, "    "));
}

// ── Preprocess ──────────────────────────────────────────────────────────────
function preprocessExpr(raw) {
    let expr = raw.trim();

    expr = expr.replace(/×/g, "*");
    expr = expr.replace(/÷/g, "/");
    expr = expr.replace(/√/g, "sqrt");
    // Jangan convert ^ → ** karena mathjs pakai ^ native
    // expr = expr.replace(/\^/g, "**");

    // Thousand separator: titik/koma diikuti tepat 3 digit
    // 15.000 → 15000, 1,000 → 1000, tapi 0.5 tetap 0.5
    expr = expr.replace(/(\d)[.,](\d{3})(?=\D|$)/g, "$1$2");

    // Persentase trailing: 15000*30% → 15000*(30/100)
    expr = expr.replace(/(\d+(?:\.\d+)?)\s*%(?!\s*\d)/g, "($1/100)");

    // Modulo antar dua angka: 100%3 tetap 100%3
    expr = expr.replace(/(\d)\s*%\s*(\d)/g, "$1%$2");

    // Hapus spasi
    expr = expr.replace(/\s+/g, "");

    // Koma sisa sebagai desimal
    expr = expr.replace(/,/g, ".");

    return expr;
}

// ── Whitelist setelah preprocess ────────────────────────────────────────────
// Hanya izinkan: angka, operator standar, kurung, %, titik desimal, sqrt, ^
const PROCESSED_SAFE_RE = /^[0-9+\-*/^%.()sqrtSQRT]+$/;

// ── Format hasil ────────────────────────────────────────────────────────────
function formatResult(num) {
    if (!isFinite(num)) return null;

    let formatted;
    if (Number.isInteger(num)) {
        formatted = num.toLocaleString("id-ID");
    } else {
        const fixed = num.toFixed(8).replace(/\.?0+$/, "");
        const [intPart, decPart] = fixed.split(".");
        const intFormatted = parseInt(intPart).toLocaleString("id-ID");
        formatted = decPart ? `${intFormatted},${decPart}` : intFormatted;
    }

    const abs = Math.abs(num);
    let shorthand = "";
    if (abs >= 1_000_000_000) {
        shorthand = ` _(${(num / 1_000_000_000).toFixed(2).replace(/\.?0+$/, "")} M)_`;
    } else if (abs >= 1_000_000) {
        shorthand = ` _(${(num / 1_000_000).toFixed(2).replace(/\.?0+$/, "")} jt)_`;
    }

    return formatted + shorthand;
}

// ── Beautify untuk display ──────────────────────────────────────────────────
function beautifyExpr(original) {
    let expr = original.trim();
    // Ganti ke simbol yang lebih bagus untuk display
    expr = expr.replace(/\*/g, " × ");
    expr = expr.replace(/\//g, " ÷ ");
    expr = expr.replace(/\+/g, " + ");
    // Jangan ganti minus di awal atau setelah operator (negatif)
    expr = expr.replace(/([0-9)])\s*-\s*/g, "$1 - ");
    expr = expr.replace(/\s{2,}/g, " ").trim();
    return expr;
}

// ── Export: deteksi ─────────────────────────────────────────────────────────
export function isMathExpression(text) {
    const t = text.trim();
    if (!t) return false;
    if (hasLettersExceptSqrt(t)) return false;
    if (!/\d/.test(t)) return false;
    // Ada operator ATAU ada sqrt( dengan angka di dalamnya
    const hasSqrt = /sqrt\s*\(\s*\d/i.test(t);
    if (!HAS_OPERATOR.test(t) && !hasSqrt) return false;
    return true;
}

// ── Export: hitung ──────────────────────────────────────────────────────────
export function evaluateMath(rawText) {
    try {
        const expr = preprocessExpr(rawText);

        // Pastikan hanya karakter aman setelah preprocessing
        if (!PROCESSED_SAFE_RE.test(expr)) return null;

        // Evaluasi dengan mathjs
        const raw = math.evaluate(expr);
        const num = typeof raw === "number" ? raw : Number(raw);

        if (!isFinite(num)) return null;
        if (isNaN(num)) return null;

        const displayExpr   = beautifyExpr(rawText);
        const displayResult = formatResult(num);
        if (!displayResult) return null;

        return { expr: displayExpr, result: displayResult, num };

    } catch (_) {
        return null;
    }
}
