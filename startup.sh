#!/bin/bash
echo "🔄 Updating yt-dlp to latest version..."

# Try runtime update from GitHub (absolute latest)
if curl -sL --max-time 30 "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o /tmp/yt-dlp-new \
   && chmod +x /tmp/yt-dlp-new \
   && /tmp/yt-dlp-new --version >/dev/null 2>&1; then
    mv /tmp/yt-dlp-new /tmp/yt-dlp
    export YTDLP_BIN=/tmp/yt-dlp
    echo "✅ yt-dlp $(/tmp/yt-dlp --version) ready (GitHub latest)"
else
    rm -f /tmp/yt-dlp-new
    # Fallback: use pip-installed yt-dlp (installed at build time)
    python3 -m pip install -U yt-dlp --break-system-packages --quiet 2>/dev/null || true
    YTDLP_PATH=$(which yt-dlp 2>/dev/null)
    if [ -n "$YTDLP_PATH" ]; then
        export YTDLP_BIN="$YTDLP_PATH"
        echo "✅ yt-dlp $(yt-dlp --version) ready (pip fallback)"
    else
        echo "⚠️  yt-dlp tidak ditemukan, download mungkin gagal"
    fi
fi

exec node bot.js
