FROM node:18-bookworm-slim

WORKDIR /app

# تثبيت الأدوات المطلوبة
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

# تثبيت dependencies أولاً للاستفادة من Docker cache
COPY package*.json ./

RUN npm install --omit=dev

# نسخ المشروع
COPY . .

# إنشاء مجلد الملفات
RUN mkdir -p /app/media

# Railway يحدد PORT وقت التشغيل
EXPOSE 3000

CMD ["npm", "start"]
