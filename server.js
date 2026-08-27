import express from "express";
import cors from "cors";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const execFilePromise = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const MEDIA_DIR = path.join(__dirname, "media");

fs.mkdirSync(MEDIA_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use(
  "/media",
  express.static(MEDIA_DIR, {
    maxAge: "1h"
  })
);

/* =========================
   HOME
========================= */

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    service: "video-worker",
    status: "online",
    message: "Video Worker is running",
    endpoints: {
      health: "/health",
      analyze: "POST /analyze"
    }
  });
});

/* =========================
   HEALTH CHECK
========================= */

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    status: "healthy",
    service: "video-worker",
    timestamp: new Date().toISOString()
  });
});

/* =========================
   HELPERS
========================= */

function isValidUrl(value) {
  try {
    const parsed = new URL(value);

    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:"
    );
  } catch {
    return false;
  }
}

function extractJson(text) {
  let cleaned = String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("Gemini did not return valid JSON.");
  }

  cleaned = cleaned.slice(firstBrace, lastBrace + 1);

  return JSON.parse(cleaned);
}

function sanitizeNumber(value, fallback = 0) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return number;
}

function cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error("Cleanup error:", error.message);
  }
}

/* =========================
   ANALYZE
========================= */

app.post("/analyze", async (req, res) => {
  const { url, videoUrl, youtubeUrl } = req.body || {};

  const targetUrl = url || videoUrl || youtubeUrl;

  if (!targetUrl) {
    return res.status(400).json({
      success: false,
      error: "Missing video URL."
    });
  }

  if (!isValidUrl(targetUrl)) {
    return res.status(400).json({
      success: false,
      error: "Invalid video URL."
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: "GEMINI_API_KEY is not configured."
    });
  }

  const timestamp = Date.now();

  const rawVideoPath = path.join(
    MEDIA_DIR,
    `raw_${timestamp}.mp4`
  );

  try {
    console.log("Downloading video:", targetUrl);

    /* =========================
       DOWNLOAD
    ========================= */

    await execFilePromise(
      "yt-dlp",
      [
        "--no-playlist",
        "-f",
        "best[height<=720]/best",
        "--merge-output-format",
        "mp4",
        "-o",
        rawVideoPath,
        targetUrl
      ],
      {
        maxBuffer: 10 * 1024 * 1024
      }
    );

    if (!fs.existsSync(rawVideoPath)) {
      throw new Error("Video download failed.");
    }

    const stats = fs.statSync(rawVideoPath);

    if (stats.size === 0) {
      throw new Error("Downloaded video is empty.");
    }

    console.log("Video downloaded:", stats.size, "bytes");

    /* =========================
       GEMINI
    ========================= */

    const genAI = new GoogleGenerativeAI(apiKey);

    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-1.5-flash"
    });

    /*
     * ملاحظة مهمة:
     * النسخة الأصلية من الكود كانت ترسل النص فقط إلى Gemini.
     * لذلك Gemini لم يكن يستلم ملف الفيديو فعلياً.
     *
     * هذا الجزء يحتاج File API / نموذج يدعم إدخال الفيديو
     * إذا كان المطلوب تحليل محتوى الفيديو نفسه.
     */

    const prompt = `
You are an expert short-form video editor.

Analyze the provided video and identify the strongest moments
for Shorts, Reels, and TikTok.

Return ONLY valid JSON.

Required format:

{
  "clips": [
    {
      "id": "clip-1",
      "start": 0,
      "end": 20,
      "title": "Engaging title",
      "hook": "Strong opening hook",
      "caption": "Suggested caption",
      "scores": {
        "hook": 90,
        "retention": 85,
        "clarity": 88
      }
    }
  ]
}

Rules:
- start and end must be numbers.
- end must be greater than start.
- Never return markdown.
- Return JSON only.
`;

    /*
     * حالياً نرسل prompt فقط.
     * يجب إضافة رفع الفيديو إلى Gemini هنا إذا كان
     * تحليل المحتوى المرئي مطلوباً فعلياً.
     */

    const result = await model.generateContent(prompt);

    const responseText = result.response.text();

    const analysisResult = extractJson(responseText);

    if (
      !analysisResult ||
      !Array.isArray(analysisResult.clips)
    ) {
      throw new Error(
        "Gemini response does not contain a valid clips array."
      );
    }

    /* =========================
       CREATE CLIPS
    ========================= */

    const host =
      process.env.PUBLIC_BASE_URL ||
      `${req.protocol}://${req.get("host")}`;

    const processedClips = [];

    for (let i = 0; i < analysisResult.clips.length; i++) {
      const clip = analysisResult.clips[i];

      const start = Math.max(
        0,
        sanitizeNumber(clip.start)
      );

      const end = Math.max(
        start + 0.1,
        sanitizeNumber(clip.end, start + 10)
      );

      const duration = end - start;

      const clipId = `clip_${timestamp}_${i + 1}`;

      const clipPath = path.join(
        MEDIA_DIR,
        `${clipId}.mp4`
      );

      await execFilePromise(
        "ffmpeg",
        [
          "-y",
          "-ss",
          String(start),
          "-i",
          rawVideoPath,
          "-t",
          String(duration),
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-c:a",
          "aac",
          "-movflags",
          "+faststart",
          clipPath
        ],
        {
          maxBuffer: 10 * 1024 * 1024
        }
      );

      if (!fs.existsSync(clipPath)) {
        continue;
      }

      processedClips.push({
        id: clip.id || `clip-${i + 1}`,
        start,
        end,
        title: clip.title || "",
        hook: clip.hook || "",
        caption: clip.caption || "",
        scores: clip.scores || {},
        previewUrl:
          `${host}/media/${clipId}.mp4`,
        rawUrl:
          `${host}/media/raw_${timestamp}.mp4`
      });
    }

    if (processedClips.length === 0) {
      throw new Error(
        "No video clips could be generated."
      );
    }

    return res.status(200).json({
      success: true,
      clips: processedClips
    });

  } catch (error) {
    console.error(
      "Worker Error:",
      error
    );

    cleanupFile(rawVideoPath);

    return res.status(500).json({
      success: false,
      error:
        error?.message ||
        "Video processing failed."
    });
  }
});

/* =========================
   GLOBAL ERROR HANDLER
========================= */

app.use((error, req, res, next) => {
  console.error(
    "Unhandled Error:",
    error
  );

  res.status(500).json({
    success: false,
    error: "Internal server error."
  });
});

/* =========================
   SERVER
========================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Video Worker running on port ${PORT}`
    );
  }
);
