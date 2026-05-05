#!/bin/bash
echo "🔄 Downloading latest yt-dlp from GitHub..."
if curl -sL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o /tmp/yt-dlp-new \
   && chmod +x /tmp/yt-dlp-new \
   && /tmp/yt-dlp-new --version >/dev/null 2>&1; then
    mv /tmp/yt-dlp-new /tmp/yt-dlp
    export YTDLP_BIN=/tmp/yt-dlp
    echo "✅ yt-dlp $(/tmp/yt-dlp --version) ready (latest)"
else
    echo "⚠️  GitHub download failed, fallback ke system yt-dlp"
    rm -f /tmp/yt-dlp-new
fi
exec node bot.js
