import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { GoogleGenAI } from '@google/genai';

const execPromise = promisify(exec);
const app = express();

app.use(cors());
app.use(express.json());
app.use('/media', express.static('media'));

// تهيئة Gemini API
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.get('/', (req, res) => {
  res.json({ success: true, service: "video-worker", status: "online" });
});

app.post('/analyze', async (req, res) => {
  const { url, videoUrl, youtubeUrl } = req.body;
  const targetUrl = url || videoUrl || youtubeUrl;

  if (!targetUrl) {
    return res.status(400).json({ success: false, error: "Missing video URL" });
  }

  const workDir = path.join(process.cwd(), 'media');
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

  const timestamp = Date.now();
  const rawVideoPath = path.join(workDir, `raw_${timestamp}.mp4`);
  const audioPath = path.join(workDir, `audio_${timestamp}.mp3`);

  try {
    // 1. تنزيل الفيديو
    await execPromise(`yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" -o "${rawVideoPath}" "${targetUrl}"`);

    // 2. استخراج الصوت
    await execPromise(`ffmpeg -i "${rawVideoPath}" -vn -acodec libmp3lame -q:a 2 "${audioPath}"`);

    // 3. رفع الصوت إلى Gemini وتحليله
    const audioFile = await ai.files.upload({
      file: audioPath,
      mimeType: 'audio/mp3',
    });

    const prompt = `أنت خبير في مقاطع الفيديو القصيرة (Shorts/Reels). قم بتحليل هذا المقطع الصوتي واستخرج أفضل المقاطع المفتاحية. 
أرجع الناتج بتنسيق JSON فقط بالشكل التالي دون نصوص إضافية:
{
  "clips": [
    {
      "id": "clip-1",
      "start": 0,
      "end": 20,
      "title": "عنوان جذاب",
      "hook": "الجملة الافتتاحية",
      "caption": "الكابتشن النصي",
      "scores": { "hook": 90, "retention": 85, "clarity": 88 }
    }
  ]
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [audioFile, prompt],
      config: { responseMimeType: 'application/json' }
    });

    const analysisResult = JSON.parse(response.text);
    const host = `${req.protocol}://${req.get('host')}`;

    // 4. قص المقاطع عبر FFmpeg
    const processedClips = [];
    for (let i = 0; i < analysisResult.clips.length; i++) {
      const clip = analysisResult.clips[i];
      const clipId = `clip_${timestamp}_${i + 1}`;
      const clipPath = path.join(workDir, `${clipId}.mp4`);
      const duration = clip.end - clip.start;

      await execPromise(`ffmpeg -ss ${clip.start} -i "${rawVideoPath}" -t ${duration} -c:v libx264 -c:a aac "${clipPath}"`);

      processedClips.push({
        id: `clip-${i + 1}`,
        start: clip.start,
        end: clip.end,
        title: clip.title,
        hook: clip.hook,
        caption: clip.caption,
        scores: clip.scores,
        previewUrl: `${host}/media/${clipId}.mp4`,
        rawUrl: `${host}/media/raw_${timestamp}.mp4`
      });
    }

    return res.json({ clips: processedClips });

  } catch (error) {
    console.error("Worker Error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker running on port ${PORT}`));
      
