import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT) || 8080;
const MEDIA_DIR = path.join(__dirname, "media");

fs.mkdirSync(MEDIA_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use(
  "/media",
  express.static(MEDIA_DIR, {
    maxAge: "1h",
    acceptRanges: true
  })
);

function requestId() {
  return `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function validUrl(value) {
  try {
    const u = new URL(value);

    return (
      u.protocol === "http:" ||
      u.protocol === "https:"
    );
  } catch {
    return false;
  }
}

function cleanJson(text) {
  let value = String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");

  if (
    start === -1 ||
    end === -1 ||
    end <= start
  ) {
    throw new Error(
      "Gemini did not return valid JSON."
    );
  }

  return JSON.parse(
    value.slice(start, end + 1)
  );
}

function number(value, fallback) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "video-worker",
    status: "online",
    port: PORT
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    status: "healthy",
    service: "video-worker"
  });
});

app.post("/analyze", async (req, res) => {
  const id = requestId();

  let rawVideoPath = null;

  try {
    console.log(`[${id}] ANALYZE START`);

    const targetUrl =
      req.body?.url ||
      req.body?.videoUrl ||
      req.body?.youtubeUrl;

    if (!targetUrl) {
      return res.status(400).json({
        success: false,
        requestId: id,
        stage: "validation",
        error: "Missing video URL."
      });
    }

    if (!validUrl(targetUrl)) {
      return res.status(400).json({
        success: false,
        requestId: id,
        stage: "validation",
        error: "Invalid video URL."
      });
    }

    const apiKey =
      process.env.GEMINI_API_KEY;

    console.log(
      `[${id}] GEMINI_API_KEY configured:`,
      Boolean(apiKey)
    );

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        requestId: id,
        stage: "gemini",
        error: "GEMINI_API_KEY is missing."
      });
    }

    const timestamp = Date.now();

    rawVideoPath = path.join(
      MEDIA_DIR,
      `raw_${timestamp}.mp4`
    );

    console.log(
      `[${id}] Downloading video...`
    );

    /*
     * Do not force best[height<=720].
     *
     * Some YouTube videos do not expose a format
     * matching that selector. Instead:
     *
     * 1. Prefer MP4 video + M4A audio.
     * 2. Fall back to best video + best audio.
     * 3. Fall back to an available MP4.
     * 4. Finally fall back to best available format.
     */
    const ytDlpArgs = [
      "--no-playlist",
      "--no-warnings",
      "--restrict-filenames",

      "-f",
      "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best",

      "--merge-output-format",
      "mp4",

      "--remux-video",
      "mp4",

      "-o",
      rawVideoPath,

      targetUrl
    ];

    console.log(
      `[${id}] Running yt-dlp...`
    );

    await execFileAsync(
      "yt-dlp",
      ytDlpArgs,
      {
        timeout: 240000,
        maxBuffer: 20 * 1024 * 1024
      }
    );

    if (!fs.existsSync(rawVideoPath)) {
      throw new Error(
        "yt-dlp completed but video file was not created."
      );
    }

    const videoStats =
      fs.statSync(rawVideoPath);

    if (videoStats.size < 1000) {
      throw new Error(
        "Downloaded video is empty or invalid."
      );
    }

    console.log(
      `[${id}] Video downloaded: ${videoStats.size} bytes`
    );

    console.log(
      `[${id}] Sending video to Gemini...`
    );

    const genAI =
      new GoogleGenerativeAI(apiKey);

    const modelName =
      process.env.GEMINI_MODEL ||
      "gemini-1.5-flash";

    const model =
      genAI.getGenerativeModel({
        model: modelName
      });

    const videoBase64 =
      fs
        .readFileSync(rawVideoPath)
        .toString("base64");

    const prompt = `
Analyze this video as an expert short-form video editor.

Find the strongest moments for YouTube Shorts,
Instagram Reels and TikTok.

Return ONLY valid JSON.

Required format:

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
- At least one clip.
- start and end must be numbers.
- end must be greater than start.
- Prefer clips from 10 to 60 seconds.
- Do not invent timestamps outside the video.
- JSON only.
`;

    const result =
      await model.generateContent([
        {
          inlineData: {
            mimeType: "video/mp4",
            data: videoBase64
          }
        },
        prompt
      ]);

    const responseText =
      result.response.text();

    console.log(
      `[${id}] Gemini response received.`
    );

    const analysis =
      cleanJson(responseText);

    if (
      !analysis ||
      !Array.isArray(analysis.clips) ||
      analysis.clips.length === 0
    ) {
      throw new Error(
        "Gemini returned no valid clips."
      );
    }

    const host =
      process.env.PUBLIC_BASE_URL ||
      `https://${req.get("host")}`;

    const clips = [];

    for (
      let i = 0;
      i < analysis.clips.length;
      i++
    ) {
      const item =
        analysis.clips[i];

      let start =
        number(item.start, 0);

      let end =
        number(
          item.end,
          start + 15
        );

      start = Math.max(
        0,
        start
      );

      end = Math.max(
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
        `[${id}] Rendering clip ${i + 1}: ${start}-${end}`
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
          timeout: 180000,
          maxBuffer:
            20 * 1024 * 1024
        }
      );

      if (
        !fs.existsSync(clipPath)
      ) {
        continue;
      }

      const clipStats =
        fs.statSync(clipPath);

      if (clipStats.size < 1000) {
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
      `[${id}] SUCCESS: ${clips.length} clips`
    );

    return res.status(200).json({
      success: true,
      requestId: id,
      clips
    });

  } catch (error) {
    console.error(
      `[${id}] ERROR:`,
      error
    );

    const message =
      String(
        error?.message || ""
      );

    let stage =
      "unknown";

    const lower =
      message.toLowerCase();

    if (
      lower.includes("yt-dlp") ||
      lower.includes("youtube") ||
      lower.includes("download") ||
      lower.includes("format")
    ) {
      stage =
        "video_download";

    } else if (
      lower.includes("gemini") ||
      lower.includes("api") ||
      lower.includes("generative")
    ) {
      stage =
        "gemini";

    } else if (
      lower.includes("ffmpeg") ||
      lower.includes("clip")
    ) {
      stage =
        "ffmpeg";
    }

    return res.status(500).json({
      success: false,
      requestId: id,
      stage,
      error:
        message ||
        "Video analysis failed."
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found.",
    path: req.path
  });
});

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `VIDEO WORKER ONLINE ON PORT ${PORT}`
    );
  }
);
