FROM node:18-slim

# تثبيت FFmpeg و Python و yt-dlp
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip && \
    pip3 install --break-system-packages yt-dlp && \
    apt-get clean

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]

