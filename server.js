import express from "express";
import cors from "cors";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
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

function cleanJson(text) {
  let value = String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");

  if (first === -1 || last === -1) {
    throw new Error(
      "Gemini did not return valid JSON."
    );
  }

  value = value.slice(
    first,
    last + 1
  );

  return JSON.parse(value);
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

function safeNumber(value, fallback) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

/* =====================================================
   GEMINI FILE UPLOAD
===================================================== */

async function uploadToGemini(
  filePath,
  apiKey,
  displayName
) {
  const fileStats =
    fs.statSync(filePath);

  const metadata = {
    file: {
      display_name: displayName
    }
  };

  /*
   * Gemini Files API upload.
   *
   * Upload is performed as resumable media.
   */

  const startResponse =
    await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "X-Goog-Upload-Protocol":
            "resumable",

          "X-Goog-Upload-Command":
            "start",

          "X-Goog-Upload-Header-Content-Length":
            String(fileStats.size),

          "X-Goog-Upload-Header-Content-Type":
            "video/mp4",

          "Content-Type":
            "application/json"
        },

        body: JSON.stringify(
          metadata
        )
      }
    );

  if (!startResponse.ok) {
    const errorText =
      await startResponse.text();

    throw new Error(
      `Gemini upload initialization failed (${startResponse.status}): ${errorText}`
    );
  }

  const uploadUrl =
    startResponse.headers.get(
      "x-goog-upload-url"
    );

  if (!uploadUrl) {
    throw new Error(
      "Gemini did not return an upload URL."
    );
  }

  const fileBuffer =
    fs.readFileSync(filePath);

  const uploadResponse =
    await fetch(uploadUrl, {
      method: "POST",

      headers: {
        "Content-Length":
          String(fileBuffer.length),

        "X-Goog-Upload-Offset":
          "0",

        "X-Goog-Upload-Command":
          "upload, finalize",

        "Content-Type":
          "video/mp4"
      },

      body: fileBuffer
    });

  if (!uploadResponse.ok) {
    const errorText =
      await uploadResponse.text();

    throw new Error(
      `Gemini video upload failed (${uploadResponse.status}): ${errorText}`
    );
  }

  const uploadJson =
    await uploadResponse.json();

  const uploadedFile =
    uploadJson.file;

  if (
    !uploadedFile ||
    !uploadedFile.uri
  ) {
    throw new Error(
      "Gemini upload succeeded but no file URI was returned."
    );
  }

  return uploadedFile;
}

/* =====================================================
   WAIT FOR GEMINI FILE
===================================================== */

async function waitForGeminiFile(
  fileName,
  apiKey
) {
  const maxAttempts = 30;

  for (
    let attempt = 0;
    attempt < maxAttempts;
    attempt++
  ) {
    const response =
      await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${encodeURIComponent(apiKey)}`
      );

    if (!response.ok) {
      const text =
        await response.text();

      throw new Error(
        `Gemini file status failed (${response.status}): ${text}`
      );
    }

    const data =
      await response.json();

    const state =
      data?.state;

    console.log(
      `Gemini file state: ${state || "UNKNOWN"}`
    );

    if (state === "ACTIVE") {
      return data;
    }

    if (
      state === "FAILED" ||
      state === "ERROR"
    ) {
      throw new Error(
        "Gemini rejected the uploaded video."
      );
    }

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          2000
        )
    );
  }

  throw new Error(
    "Timed out waiting for Gemini to process the video."
  );
}

/* =====================================================
   GEMINI ANALYSIS
===================================================== */

async function analyzeVideo(
  file,
  apiKey
) {
  const model =
    process.env.GEMINI_MODEL ||
    "gemini-1.5-flash";

  const prompt = `
Analyze the uploaded video as an expert short-form
video editor.

Identify the strongest moments suitable for:

- YouTube Shorts
- Instagram Reels
- TikTok

Look for:

- strong hooks
- surprising statements
- emotional moments
- useful information
- controversial or interesting moments
- high retention potential
- sections that work independently

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

- start must be a number.
- end must be a number.
- end must be greater than start.
- Prefer clips between 10 and 60 seconds.
- Do not invent timestamps.
- Return JSON only.
- No markdown.
- No explanation.
`;

  const response =
    await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  file_data: {
                    mime_type:
                      file.mimeType ||
                      "video/mp4",

                    file_uri:
                      file.uri
                  }
                },

                {
                  text: prompt
                }
              ]
            }
          ],

          generationConfig: {
            temperature: 0.2,
            responseMimeType:
              "application/json"
          }
        })
      }
    );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Gemini analysis failed (${response.status}): ${errorText}`
    );
  }

  const data =
    await response.json();

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

  if (!text) {
    throw new Error(
      "Gemini returned an empty response."
    );
  }

  return cleanJson(text);
}

/* =====================================================
   ANALYZE ENDPOINT
===================================================== */

app.post(
  "/analyze",
  async (req, res) => {
    const requestId =
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

    let rawVideoPath = null;

    try {
      console.log(
        `[${requestId}] Analyze started`
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

      if (!targetUrl) {
        return res.status(400).json({
          success: false,
          requestId,
          error:
            "Missing video URL."
        });
      }

      if (
        !isValidUrl(
          targetUrl
        )
      ) {
        return res.status(400).json({
          success: false,
          requestId,
          error:
            "Invalid video URL."
        });
      }

      const apiKey =
        process.env.GEMINI_API_KEY;

      if (!apiKey) {
        return res.status(500).json({
          success: false,
          requestId,
          error:
            "GEMINI_API_KEY is missing in Railway Variables.",
          stage: "configuration"
        });
      }

      const timestamp =
        Date.now();

      rawVideoPath =
        path.join(
          MEDIA_DIR,
          `raw_${timestamp}.mp4`
        );

      /* ---------------------------------------------
         DOWNLOAD
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
        !fs.existsSync(
          rawVideoPath
        )
      ) {
        throw new Error(
          "Video download failed: file was not created."
        );
      }

      const stats =
        fs.statSync(
          rawVideoPath
        );

      console.log(
        `[${requestId}] Video size: ${stats.size}`
      );

      if (stats.size < 1000) {
        throw new Error(
          "Downloaded video is empty."
        );
      }

      /* ---------------------------------------------
         UPLOAD
      --------------------------------------------- */

      console.log(
        `[${requestId}] Uploading video to Gemini`
      );

      const uploaded =
        await uploadToGemini(
          rawVideoPath,
          apiKey,
          `video-${timestamp}.mp4`
        );

      console.log(
        `[${requestId}] Uploaded:`,
        uploaded.name
      );

      /* ---------------------------------------------
         WAIT
      --------------------------------------------- */

      const activeFile =
        await waitForGeminiFile(
          uploaded.name,
          apiKey
        );

      /* ---------------------------------------------
         ANALYZE
      --------------------------------------------- */

      console.log(
        `[${requestId}] Analyzing video`
      );

      const analysis =
        await analyzeVideo(
          activeFile,
          apiKey
        );

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
         RENDER
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
          `[${requestId}] Rendering ${clipId}`
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
          "FFmpeg did not create any clips."
        );
      }

      console.log(
        `[${requestId}] SUCCESS - ${clips.length} clips`
      );

      return res.status(200).json({
        success: true,
        requestId,
        clips
      });

    } catch (error) {
      console.error(
        `[${requestId}] ERROR:`,
        error
      );

      removeFile(
        rawVideoPath
      );

      return res.status(500).json({
        success: false,
        requestId,
        error:
          error?.message ||
          "Video processing failed."
      });
    }
  }
);

/* =====================================================
   404
===================================================== */

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      error: "Route not found.",
      path: req.path
    });
  }
);

/* =====================================================
   SERVER
===================================================== */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "================================"
    );

    console.log(
      "VIDEO WORKER ONLINE"
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
