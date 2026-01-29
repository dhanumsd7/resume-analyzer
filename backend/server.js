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

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// ---------------------------------------------------------------------------
// Global process-level guards
// ---------------------------------------------------------------------------
// Render free tier is memory/CPU constrained. In rare cases a bug in parsing
// or an unexpected rejection could surface as an unhandled error. We register
// safety handlers so the Node process keeps running and always returns JSON
// on subsequent requests instead of crashing the whole service.
process.on("uncaughtException", (err) => {
  console.error("[backend] Uncaught exception:", err);
  // Intentionally DO NOT call process.exit() so the container keeps serving.
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[backend] Unhandled rejection at:", promise, "reason:", reason);
  // Same idea: log and keep process alive.
});

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
 * - Enforce a strict ~200 KB file limit (defensive against heavy PDFs).
 * - Support only PDF/TXT.
 * - Always delete the temp file after parsing (success or failure).
 */
const TMP_DIR_PRIMARY = "/tmp"; // Render/Linux temp directory
const TMP_DIR_FALLBACK = os.tmpdir(); // local dev fallback (e.g., Windows)
const MAX_UPLOAD_BYTES = 200 * 1024; // 200 KB hard cap for free-tier safety

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
    // Multer-level guard. We also defensively check size in the handler.
    fileSize: MAX_UPLOAD_BYTES
  }
});

// ---------------------------------------------------------------------------
// Multer error handler middleware
// ---------------------------------------------------------------------------
// Multer errors (fileFilter rejections, size limits) don't go through normal
// Express error handlers. We catch them here and return JSON responses.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        message: "File too large. Please upload a resume up to 200 KB."
      });
    }
    return res.status(400).json({
      success: false,
      message: err.message || "File upload error."
    });
  }
  if (err && err.statusCode === 400) {
    // File filter rejection (unsupported type)
    return res.status(400).json({
      success: false,
      message: err.message || "Unsupported file type."
    });
  }
  next(err);
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
    // Check file size before reading to prevent memory spikes.
    const stats = await fs.stat(file.path);
    if (stats.size > MAX_UPLOAD_BYTES) {
      const err = new Error("File too large. Please upload a resume up to 200 KB.");
      err.statusCode = 413;
      throw err;
    }

    const buf = await fs.readFile(file.path);
    try {
      const parsed = await pdfParse(buf);
      const text = String(parsed.text || "");
      
      // Defensive: reject if extracted text is suspiciously large (could indicate
      // a problematic PDF that consumed too much memory during parsing).
      if (text.length > 50000) {
        const err = new Error("PDF contains too much text. Please use a simpler resume file.");
        err.statusCode = 400;
        throw err;
      }
      
      return text;
    } catch (e) {
      // If it's already our error, re-throw
      if (e && e.statusCode) throw e;
      
      const err = new Error(
        "Could not read PDF. Ensure it is not password-protected, corrupted, or overly complex."
      );
      err.statusCode = 400;
      throw err;
    }
  }

  if (isTxt) {
    // Check file size before reading
    const stats = await fs.stat(file.path);
    if (stats.size > MAX_UPLOAD_BYTES) {
      const err = new Error("File too large. Please upload a resume up to 200 KB.");
      err.statusCode = 413;
      throw err;
    }
    
    const text = await fs.readFile(file.path, "utf8");
    
    // Defensive: reject if text is suspiciously large
    if (text.length > 50000) {
      const err = new Error("Text file is too large. Please use a simpler resume file.");
      err.statusCode = 400;
      throw err;
    }
    
    return text;
  }

  // Should be blocked by multer fileFilter, but keep a safe guard.
  const err = new Error("Unsupported file type. Please upload a PDF or TXT resume.");
  err.statusCode = 400;
  throw err;
}

app.post("/analyze", upload.single("file"), async (req, res) => {
  let tmpPath = null;
  let timeoutId = null;

  // Request timeout: 15 seconds max. Prevents hanging requests that could
  // cause Render to kill the container due to resource limits.
  const REQUEST_TIMEOUT_MS = 15000;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("Request timeout. Processing took too long."));
    }, REQUEST_TIMEOUT_MS);
  });

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded. Please attach a resume using form field name 'file'."
      });
    }

    tmpPath = req.file.path;

    // Additional application-level size guard in case the upstream limit
    // configuration changes. This ensures we never attempt to parse heavy
    // documents on resource-constrained infrastructure.
    if (req.file.size > MAX_UPLOAD_BYTES) {
      return res.status(413).json({
        success: false,
        message: "File too large. Please upload a resume up to 200 KB."
      });
    }

    // Race between actual processing and timeout. If processing completes
    // first, we clear the timeout. If timeout fires first, we abort.
    const textPromise = extractTextFromUpload(req.file);
    const text = await Promise.race([textPromise, timeoutPromise]);

    if (!text || text.trim().length < 30) {
      return res.status(400).json({
        success: false,
        message: "Could not extract enough text from the resume. Try a different PDF/TXT."
      });
    }

    // Wrap analyzer call defensively. Even though it's deterministic, we
    // want to catch any unexpected errors (e.g., if text is extremely long
    // and causes memory issues).
    let analysis;
    try {
      const analysisPromise = Promise.resolve(analyzeResume(text));
      analysis = await Promise.race([analysisPromise, timeoutPromise]);
    } catch (analyzerErr) {
      console.error("[backend] analyzer error:", analyzerErr);
      return res.status(500).json({
        success: false,
        message: "Analysis failed. The resume may be too complex or contain invalid content."
      });
    }

    // Clear timeout since we're about to send response
    if (timeoutId) clearTimeout(timeoutId);

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

    // Clear timeout on error
    if (timeoutId) clearTimeout(timeoutId);

    // Timeout errors
    if (err && err.message && err.message.includes("timeout")) {
      return res.status(504).json({
        success: false,
        message: "Processing took too long. Please try a smaller or simpler resume file."
      });
    }

    // Multer-specific errors (should be caught by middleware, but defensive)
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        message: "File too large. Please upload a resume up to 200 KB."
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
    // Clear timeout in finally as well
    if (timeoutId) clearTimeout(timeoutId);
  }
});

// ---------------------------------------------------------------------------
// Global Express error handler (catches any remaining unhandled errors)
// ---------------------------------------------------------------------------
// This is the final safety net. Any error that reaches here will be converted
// to a JSON response so the frontend never receives invalid data.
app.use((err, req, res, next) => {
  console.error("[backend] Unhandled Express error:", err);
  
  // If response already sent, delegate to default handler
  if (res.headersSent) {
    return next(err);
  }

  // Always return JSON, never crash or send raw error
  res.status(500).json({
    success: false,
    message: "An unexpected error occurred. Please try again."
  });
});

app.listen(PORT, () => {
  console.log(`[backend] ResumeLens backend running on http://localhost:${PORT}`);
});

