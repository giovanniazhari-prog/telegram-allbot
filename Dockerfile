FROM node:20-slim

RUN apt-get update && apt-get install -y ffmpeg curl --no-install-recommends && rm -rf /var/lib/apt/lists/*

RUN curl -L "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && yt-dlp --version

WORKDIR /app
COPY package.json .
RUN npm install
COPY . .

ENV YTDLP_BIN=/usr/local/bin/yt-dlp

CMD ["node", "bot.js"]
