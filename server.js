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

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT) || 8080;

const MEDIA_DIR = path.join(__dirname, "media");

fs.mkdirSync(MEDIA_DIR, {
  recursive: true
});

app.use(cors());

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  "/media",
  express.static(MEDIA_DIR)
);

/* =========================
   HOME
========================= */

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    service: "video-worker",
    status: "online",
    port: PORT,
    message: "Video Worker is running",
    endpoints: {
      health: "/health",
      analyze: "POST /analyze"
    }
  });
});

/* =========================
   HEALTH
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
   URL VALIDATION
========================= */

function isValidUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "http:" ||
      url.protocol === "https:"
    );
  } catch {
    return false;
  }
}

/* =========================
   JSON PARSER
========================= */

function parseGeminiJson(text) {
  let cleaned = String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");

  if (first === -1 || last === -1) {
    throw new Error(
      "Gemini returned an invalid JSON response."
    );
  }

  cleaned = cleaned.substring(
    first,
    last + 1
  );

  return JSON.parse(cleaned);
}

/* =========================
   CLEANUP
========================= */

function removeFile(file) {
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (error) {
    console.error(
      "Could not remove file:",
      error.message
    );
  }
}

/* =========================
   ANALYZE
========================= */

app.post("/analyze", async (req, res) => {
  const {
    url,
    videoUrl,
    youtubeUrl
  } = req.body || {};

  const targetUrl =
    url ||
    videoUrl ||
    youtubeUrl;

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

  const apiKey =
    process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error:
        "GEMINI_API_KEY is not configured in Railway Variables."
    });
  }

  const timestamp = Date.now();

  const rawVideoPath =
    path.join(
      MEDIA_DIR,
      `raw_${timestamp}.mp4`
    );

  try {
    console.log(
      "Starting video download..."
    );

    console.log(
      "URL:",
      targetUrl
    );

    /* =========================
       YT-DLP
    ========================= */

    await execFileAsync(
      "yt-dlp",
      [
        "--no-playlist",
        "--restrict-filenames",
        "-f",
        "best[height<=720]/best",
        "--merge-output-format",
        "mp4",
        "-o",
        rawVideoPath,
        targetUrl
      ],
      {
        maxBuffer:
          20 * 1024 * 1024
      }
    );

    if (!fs.existsSync(rawVideoPath)) {
      throw new Error(
        "yt-dlp finished but no video file was created."
      );
    }

    const fileStats =
      fs.statSync(rawVideoPath);

    if (fileStats.size <= 0) {
      throw new Error(
        "Downloaded video is empty."
      );
    }

    console.log(
      "Video downloaded successfully:",
      fileStats.size,
      "bytes"
    );

    /* =========================
       GEMINI
    ========================= */

    const genAI =
      new GoogleGenerativeAI(
        apiKey
      );

    const model =
      genAI.getGenerativeModel({
        model:
          process.env.GEMINI_MODEL ||
          "gemini-1.5-flash"
      });

    const prompt = `
You are an expert short-form video editor.

Analyze the video and identify the strongest moments
that could work as YouTube Shorts, Instagram Reels,
or TikTok clips.

Return ONLY valid JSON.

Use exactly this structure:

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

- start must be a number.
- end must be a number.
- end must be greater than start.
- Do not return markdown.
- Do not return explanations.
- Return JSON only.
`;

    /*
     * ملاحظة:
     * هذا الطلب يرسل Prompt إلى Gemini.
     * لكي يقوم Gemini بتحليل الصورة والصوت داخل الفيديو
     * نفسه، يجب استخدام آلية رفع ملفات الفيديو المناسبة
     * لنموذج Gemini/API المستخدم فعلياً.
     */

    const result =
      await model.generateContent(
        prompt
      );

    const responseText =
      result.response.text();

    const analysis =
      parseGeminiJson(
        responseText
      );

    if (
      !analysis ||
      !Array.isArray(
        analysis.clips
      )
    ) {
      throw new Error(
        "Gemini response does not contain a clips array."
      );
    }

    /* =========================
       GENERATE CLIPS
    ========================= */

    const host =
      process.env.PUBLIC_BASE_URL ||
      `${req.protocol}://${req.get("host")}`;

    const clips = [];

    for (
      let i = 0;
      i < analysis.clips.length;
      i++
    ) {
      const item =
        analysis.clips[i];

      let start =
        Number(item.start);

      let end =
        Number(item.end);

      if (!Number.isFinite(start)) {
        start = 0;
      }

      if (!Number.isFinite(end)) {
        end = start + 10;
      }

      start = Math.max(
        0,
        start
      );

      end = Math.max(
        start + 0.1,
        end
      );

      const duration =
        end - start;

      const clipId =
        `clip_${timestamp}_${i + 1}`;

      const clipPath =
        path.join(
          MEDIA_DIR,
          `${clipId}.mp4`
        );

      console.log(
        `Creating clip ${i + 1}: ${start}-${end}`
      );

      await execFileAsync(
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
          maxBuffer:
            20 * 1024 * 1024
        }
      );

      if (
        !fs.existsSync(
          clipPath
        )
      ) {
        continue;
      }

      clips.push({
        id:
          item.id ||
          `clip-${i + 1}`,

        start,
        end,

        title:
          item.title || "",

        hook:
          item.hook || "",

        caption:
          item.caption || "",

        scores:
          item.scores || {},

        previewUrl:
          `${host}/media/${clipId}.mp4`,

        rawUrl:
          `${host}/media/raw_${timestamp}.mp4`
      });
    }

    if (clips.length === 0) {
      throw new Error(
        "No clips were generated."
      );
    }

    return res.status(200).json({
      success: true,
      clips
    });

  } catch (error) {
    console.error(
      "===================="
    );

    console.error(
      "VIDEO WORKER ERROR"
    );

    console.error(
      error
    );

    console.error(
      "===================="
    );

    removeFile(
      rawVideoPath
    );

    return res.status(500).json({
      success: false,
      error:
        error?.message ||
        "Video processing failed."
    });
  }
});

/* =========================
   404
========================= */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found.",
    path: req.path
  });
});

/* =========================
   GLOBAL ERROR
========================= */

app.use(
  (error, req, res, next) => {
    console.error(
      "Unhandled server error:",
      error
    );

    res.status(500).json({
      success: false,
      error:
        "Internal server error."
    });
  }
);

/* =========================
   START SERVER
========================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "================================"
    );

    console.log(
      "VIDEO WORKER STARTED"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      "HOST: 0.0.0.0"
    );

    console.log(
      "================================"
    );
  }
);
