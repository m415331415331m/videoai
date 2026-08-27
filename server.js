import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';

const execPromise = promisify(exec);
const app = express();

app.use(cors());
app.use(express.json());
app.use('/media', express.static('media'));

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ success: true, service: "video-worker", status: "online" });
});

app.post('/analyze', async (req, res) => {
  const { url, videoUrl, youtubeUrl } = req.body;
  const targetUrl = url || videoUrl || youtubeUrl;

  if (!targetUrl) {
    return res.status(400).json({ success: false, error: "Missing video URL" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ success: false, error: "GEMINI_API_KEY is not set in Railway variables" });
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const workDir = path.join(process.cwd(), 'media');
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

  const timestamp = Date.now();
  const rawVideoPath = path.join(workDir, `raw_${timestamp}.mp4`);
  const audioPath = path.join(workDir, `audio_${timestamp}.mp3`);

  try {
    // 1. تنزيل الفيديو وجودة منخفضة لتوفير الذاكرة
    await execPromise(`yt-dlp -f "best[height<=720]" -o "${rawVideoPath}" "${targetUrl}"`);

    // 2. استخراج الصوت بصيغة MP3 للتحليل
    await execPromise(`ffmpeg -i "${rawVideoPath}" -vn -acodec libmp3lame -q:a 4 "${audioPath}"`);

    // 3. قراءة ملف الصوت وتحويله لـ Base64 لإرساله لـ Gemini
    const audioBuffer = fs.readFileSync(audioPath);
    const audioBase64 = audioBuffer.toString("base64");

    const prompt = `أنت خبير في مقاطع الفيديو القصيرة (Shorts/Reels). قم بتحليل هذا المقطع الصوتي المرفق واستخرج أفضل المقاطع المفتاحية ذات الجاذبية العالية.
أرجع الناتج بتنسيق JSON فقط دون أي نصوص إضافية أو علامات markdown خارج الكود:
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

    // إرسال الصوت المباشر مع الـ Prompt لـ Gemini
    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: "audio/mp3",
          data: audioBase64
        }
      }
    ]);

    const responseText = result.response.text();
    const cleanJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    const analysisResult = JSON.parse(cleanJson);

    const host = `${req.protocol}://${req.get('host')}`;

    // 4. قص المقاطع ومعالجتها بناءً على التحليل
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

    // تنظيف الملف الصوتي المؤقت
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

    return res.json({ clips: processedClips });

  } catch (error) {
    console.error("Worker Error:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
