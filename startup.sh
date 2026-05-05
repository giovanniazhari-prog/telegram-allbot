#!/bin/bash
echo "🔄 Mengunduh yt-dlp_linux (standalone binary) dari GitHub..."

# Download yt-dlp_linux — tidak butuh Python
if curl -sL --max-time 60 "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" -o /tmp/yt-dlp-new \
   && chmod +x /tmp/yt-dlp-new \
   && /tmp/yt-dlp-new --version >/dev/null 2>&1; then
    mv /tmp/yt-dlp-new /tmp/yt-dlp
    export YTDLP_BIN=/tmp/yt-dlp
    echo "✅ yt-dlp $(/tmp/yt-dlp --version) ready (GitHub latest standalone)"
else
    rm -f /tmp/yt-dlp-new
    echo "⚠️  Download yt-dlp gagal, bot.js akan coba update sendiri"
fi

exec node bot.js
