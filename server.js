import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT) || 8080;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.status(200).json({
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

app.post("/analyze", (req, res) => {
  res.status(503).json({
    success: false,
    error: "Video analysis is temporarily unavailable while the worker is initializing."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`VIDEO WORKER ONLINE ON PORT ${PORT}`);
});
