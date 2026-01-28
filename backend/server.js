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

const { analyzeResume } = require("./analyzer");

const PORT = process.env.PORT ? Number(process.env.PORT) : 5000;

const app = express();

// Allow frontend (file:// or any dev server) to call backend during development.
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Use memory storage so we can parse PDF buffer directly.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
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
    const parsed = await pdfParse(file.buffer);
    return String(parsed.text || "");
  }

  if (isTxt) {
    return file.buffer.toString("utf8");
  }

  // Frontend currently allows .doc/.docx selection, but this backend intentionally supports PDF/TXT only.
  // We return a clear error message to avoid silent failures.
  const err = new Error("Unsupported file type. Please upload a PDF or TXT resume.");
  err.statusCode = 400;
  throw err;
}

app.post("/analyze", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded. Please attach a resume using form field name 'file'."
      });
    }

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
    const status = err && Number.isInteger(err.statusCode) ? err.statusCode : 500;
    return res.status(status).json({
      success: false,
      message: err && err.message ? err.message : "Server error during analysis."
    });
  }
});

app.listen(PORT, () => {
  console.log(`[backend] ResumeLens backend running on http://localhost:${PORT}`);
});

