FROM node:18-bookworm-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        python3-pip \
        ca-certificates \
        curl && \
    pip3 install --no-cache-dir --break-system-packages yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/media

ENV NODE_ENV=production

EXPOSE 8080

CMD ["npm", "start"]
