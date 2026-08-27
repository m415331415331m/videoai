import express from "express";
import cors from "cors";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  GoogleGenerativeAI,
  GoogleAIFileManager
} from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT) || 8080;

const MEDIA_DIR = path.join(
  __dirname,
  "media"
);

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
  express.static(MEDIA_DIR, {
    maxAge: "1h"
  })
);

/* =====================================================
   HOME
===================================================== */

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

/* =====================================================
   HEALTH
===================================================== */

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    status: "healthy",
    service: "video-worker",
    timestamp: new Date().toISOString()
  });
});

/* =====================================================
   HELPERS
===================================================== */

function validUrl(value) {
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

function cleanGeminiJson(text) {
  let value = String(text || "")
    .trim()
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");

  if (
    firstBrace === -1 ||
    lastBrace === -1
  ) {
    throw new Error(
      "Gemini did not return JSON."
    );
  }

  value = value.substring(
    firstBrace,
    lastBrace + 1
  );

  return JSON.parse(value);
}

function safeNumber(value, fallback) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function removeFile(filePath) {
  try {
    if (
      filePath &&
      fs.existsSync(filePath)
    ) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error(
      "Cleanup error:",
      error.message
    );
  }
}

/* =====================================================
   ANALYZE
===================================================== */

app.post("/analyze", async (req, res) => {
  const requestId =
    `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  let rawVideoPath = null;
  let uploadedGeminiFile = null;

  try {
    console.log(
      `[${requestId}] Analyze request received`
    );

    const {
      url,
      videoUrl,
      youtubeUrl
    } = req.body || {};

    const targetUrl =
      url ||
      videoUrl ||
      youtubeUrl;

    /* ---------------------------------------------
       Validate URL
    --------------------------------------------- */

    if (!targetUrl) {
      return res.status(400).json({
        success: false,
        requestId,
        error: "Missing video URL."
      });
    }

    if (!validUrl(targetUrl)) {
      return res.status(400).json({
        success: false,
        requestId,
        error: "Invalid video URL."
      });
    }

    /* ---------------------------------------------
       Gemini API key
    --------------------------------------------- */

    const apiKey =
      process.env.GEMINI_API_KEY;

    if (!apiKey) {
      console.error(
        `[${requestId}] GEMINI_API_KEY missing`
      );

      return res.status(500).json({
        success: false,
        requestId,
        error:
          "GEMINI_API_KEY is missing in Railway Variables."
      });
    }

    const timestamp = Date.now();

    rawVideoPath = path.join(
      MEDIA_DIR,
      `raw_${timestamp}.mp4`
    );

    /* ---------------------------------------------
       Download video
    --------------------------------------------- */

    console.log(
      `[${requestId}] Downloading video`
    );

    await execFileAsync(
      "yt-dlp",
      [
        "--no-playlist",
        "--no-warnings",
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
          30 * 1024 * 1024
      }
    );

    if (
      !fs.existsSync(rawVideoPath)
    ) {
      throw new Error(
        "yt-dlp completed but video file was not created."
      );
    }

    const stats =
      fs.statSync(rawVideoPath);

    console.log(
      `[${requestId}] Download complete: ${stats.size} bytes`
    );

    if (stats.size < 1000) {
      throw new Error(
        "Downloaded video is empty or invalid."
      );
    }

    /* ---------------------------------------------
       Gemini
    --------------------------------------------- */

    console.log(
      `[${requestId}] Initializing Gemini`
    );

    const genAI =
      new GoogleGenerativeAI(apiKey);

    const fileManager =
      new GoogleAIFileManager(apiKey);

    const modelName =
      process.env.GEMINI_MODEL ||
      "gemini-1.5-flash";

    const model =
      genAI.getGenerativeModel({
        model: modelName
      });

    /* ---------------------------------------------
       Upload video to Gemini
    --------------------------------------------- */

    console.log(
      `[${requestId}] Uploading video to Gemini`
    );

    const upload =
      await fileManager.uploadFile(
        rawVideoPath,
        {
          mimeType: "video/mp4",
          displayName:
            `video-${timestamp}.mp4`
        }
      );

    uploadedGeminiFile =
      upload.file;

    console.log(
      `[${requestId}] Gemini file uploaded:`,
      uploadedGeminiFile.uri
    );

    /* ---------------------------------------------
       Analyze actual video
    --------------------------------------------- */

    const prompt = `
You are an expert short-form video editor.

Analyze the uploaded video itself.

Find the strongest moments that could become
YouTube Shorts, Instagram Reels, or TikTok clips.

Look for:
- strong hooks
- interesting statements
- surprising moments
- emotional moments
- useful information
- high retention potential
- clear standalone sections

Return ONLY valid JSON.

Use exactly:

{
  "clips": [
    {
      "id": "clip-1",
      "start": 0,
      "end": 20,
      "title": "عنوان جذاب",
      "hook": "الجملة الافتتاحية",
      "caption": "كابتشن مناسب",
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
- clips must contain at least one item.
- Prefer clips between 10 and 60 seconds.
- Do not invent timestamps outside the video.
- Return JSON only.
- No markdown.
- No explanation.
`;

    console.log(
      `[${requestId}] Asking Gemini to analyze video`
    );

    const result =
      await model.generateContent([
        {
          fileData: {
            mimeType:
              uploadedGeminiFile.mimeType ||
              "video/mp4",
            fileUri:
              uploadedGeminiFile.uri
          }
        },
        prompt
      ]);

    const text =
      result.response.text();

    console.log(
      `[${requestId}] Gemini response received`
    );

    const analysis =
      cleanGeminiJson(text);

    if (
      !analysis ||
      !Array.isArray(
        analysis.clips
      ) ||
      analysis.clips.length === 0
    ) {
      throw new Error(
        "Gemini returned no valid clips."
      );
    }

    /* ---------------------------------------------
       Generate clips
    --------------------------------------------- */

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
        safeNumber(
          item.start,
          0
        );

      let end =
        safeNumber(
          item.end,
          start + 15
        );

      start =
        Math.max(
          0,
          start
        );

      end =
        Math.max(
          start + 1,
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
        `[${requestId}] Rendering clip ${i + 1}: ${start}-${end}`
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
            30 * 1024 * 1024
        }
      );

      if (
        !fs.existsSync(clipPath)
      ) {
        console.error(
          `[${requestId}] Clip file missing`
        );

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
        "FFmpeg did not generate any clips."
      );
    }

    console.log(
      `[${requestId}] SUCCESS: ${clips.length} clips`
    );

    return res.status(200).json({
      success: true,
      requestId,
      clips
    });

  } catch (error) {
    console.error(
      `[${requestId}] ANALYZE ERROR`
    );

    console.error(error);

    removeFile(
      rawVideoPath
    );

    return res.status(500).json({
      success: false,
      requestId,
      error:
        error?.message ||
        "Video analysis failed.",
      stage: detectStage(error)
    });
  }
});

/* =====================================================
   ERROR STAGE
===================================================== */

function detectStage(error) {
  const message =
    String(
      error?.message || ""
    ).toLowerCase();

  if (
    message.includes("yt-dlp") ||
    message.includes("download")
  ) {
    return "video_download";
  }

  if (
    message.includes("gemini") ||
    message.includes("api") ||
    message.includes("file")
  ) {
    return "gemini";
  }

  if (
    message.includes("ffmpeg") ||
    message.includes("clip")
  ) {
    return "ffmpeg";
  }

  if (
    message.includes("json")
  ) {
    return "gemini_response";
  }

  return "unknown";
}

/* =====================================================
   404
===================================================== */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found.",
    path: req.path
  });
});

/* =====================================================
   GLOBAL ERROR
===================================================== */

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

/* =====================================================
   START
===================================================== */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "======================================"
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
      `NODE_ENV: ${process.env.NODE_ENV || "development"}`
    );

    console.log(
      "======================================"
    );
  }
);
