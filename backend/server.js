/**
 * server.js
 *
 * What was wrong before:
 * - Backend entry file was missing / not configured, so Node couldn't start.
 * - No Express app, no CORS/JSON middleware, and no upload endpoint contract.
 *
 * Fix:
 * - Create a proper Express server with CORS + JSON parsing.
 * - Add /health endpoint.
 * - Add POST /analyze that accepts upload.single("file") (multer),
 *   extracts text from PDF/TXT, calls analyzer.js, and returns { success, data }.
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { analyzeResume } = require("./analyzer");

const PORT = process.env.PORT ? Number(process.env.PORT) : 5000;

const app = express();

// Allow frontend (file:// or any dev server) to call backend during development.
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/**
 * DEPLOYMENT-SAFE UPLOADS (Render free tier)
 *
 * What was wrong:
 * - `multer.memoryStorage()` keeps the whole file in RAM.
 * - `pdf-parse` also allocates buffers while parsing.
 * - On low-memory containers (Render free tier), that can trigger OOM kills where the process is terminated
 *   and nothing is catchable in try/catch.
 *
 * Fix:
 * - Use disk storage to a temp directory (Render-safe `/tmp`).
 * - Enforce a strict 1 MB file limit.
 * - Support only PDF/TXT.
 * - Always delete the temp file after parsing (success or failure).
 */
const TMP_DIR_PRIMARY = "/tmp"; // Render/Linux temp directory
const TMP_DIR_FALLBACK = os.tmpdir(); // local dev fallback (e.g., Windows)

function safeTmpDir() {
  // Prefer /tmp for Render; fallback for local dev environments without /tmp.
  return TMP_DIR_PRIMARY || TMP_DIR_FALLBACK;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, safeTmpDir());
  },
  filename: (req, file, cb) => {
    // Unique, safe filename; keep original extension if present.
    const ext = path.extname(file.originalname || "").slice(0, 12); // small guard
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    cb(null, `resumelens-${unique}${ext}`);
  }
});

function fileFilter(req, file, cb) {
  const original = (file.originalname || "").toLowerCase();
  const mime = (file.mimetype || "").toLowerCase();

  const isPdf = mime === "application/pdf" || original.endsWith(".pdf");
  const isTxt = mime === "text/plain" || original.endsWith(".txt");

  if (isPdf || isTxt) return cb(null, true);

  const err = new Error("Unsupported file type. Please upload a PDF or TXT resume.");
  err.statusCode = 400;
  return cb(err);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 1 * 1024 * 1024 // 1 MB
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "resumelens-backend", time: new Date().toISOString() });
});

async function extractTextFromUpload(file) {
  const original = (file.originalname || "").toLowerCase();
  const mime = (file.mimetype || "").toLowerCase();

  const isPdf = mime === "application/pdf" || original.endsWith(".pdf");
  const isTxt = mime === "text/plain" || original.endsWith(".txt");

  if (isPdf) {
    // Read from disk to avoid keeping multipart file in RAM.
    const buf = await fs.readFile(file.path);
    const parsed = await pdfParse(buf);
    return String(parsed.text || "");
  }

  if (isTxt) {
    return await fs.readFile(file.path, "utf8");
  }

  // Should be blocked by multer fileFilter, but keep a safe guard.
  const err = new Error("Unsupported file type. Please upload a PDF or TXT resume.");
  err.statusCode = 400;
  throw err;
}

app.post("/analyze", upload.single("file"), async (req, res) => {
  let tmpPath = null;
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded. Please attach a resume using form field name 'file'."
      });
    }

    tmpPath = req.file.path;
    const text = await extractTextFromUpload(req.file);
    if (!text || text.trim().length < 30) {
      return res.status(400).json({
        success: false,
        message: "Could not extract enough text from the resume. Try a different PDF/TXT."
      });
    }

    const analysis = analyzeResume(text);

    return res.json({
      success: true,
      data: {
        atsScore: analysis.atsScore,
        skillsFound: analysis.skillsFound,
        missingSkills: analysis.missingSkills,
        suggestions: analysis.suggestions
      }
    });
  } catch (err) {
    console.error("[backend] /analyze error:", err);

    // Multer-specific errors (e.g., file too large)
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        message: "File too large. Max upload size is 1 MB."
      });
    }

    const status = err && Number.isInteger(err.statusCode) ? err.statusCode : 500;
    return res.status(status).json({
      success: false,
      message: err && err.message ? err.message : "Server error during analysis."
    });
  } finally {
    // ALWAYS delete temp file so /tmp doesn't fill up and to reduce disk usage on Render.
    if (tmpPath) {
      try {
        await fs.unlink(tmpPath);
      } catch (e) {
        // Not fatal; just log for visibility.
        console.warn("[backend] temp file cleanup failed:", e && e.message ? e.message : e);
      }
    }
  }
});

app.listen(PORT, () => {
  console.log(`[backend] ResumeLens backend running on http://localhost:${PORT}`);
});

