/**
 * ResumeLens AI - Frontend integration with backend /analyze endpoint.
 * Fixes: FormData upload, fetch (no Content-Type), response handling, error display,
 * and defensive coding so animation-related errors do not block execution.
 */

(function () {
  "use strict";

  const API_BASE = "https://resume-backend-production-4fb6.up.railway.app/";
  const ANALYZE_ENDPOINT = API_BASE + "/analyze";

  /** @type {HTMLInputElement | null} */
  let resumeInput = null;
  /** @type {HTMLElement | null} */
  let fileInfo = null;
  /** @type {HTMLButtonElement | null} */
  let analyzeBtn = null;
  /** @type {HTMLElement | null} */
  let uploadSection = null;
  /** @type {HTMLElement | null} */
  let scanningSection = null;
  /** @type {HTMLElement | null} */
  let resultsSection = null;
  /** @type {HTMLElement | null} */
  let scanningStatus = null;
  /** @type {SVGCircleElement | null} */
  let meterProgress = null;
  /** @type {HTMLElement | null} */
  let atsScoreEl = null;
  /** @type {HTMLElement | null} */
  let foundSkillsList = null;
  /** @type {HTMLElement | null} */
  let missingSkillsList = null;
  /** @type {HTMLElement | null} */
  let suggestionsList = null;
  /** @type {HTMLButtonElement | null} */
  let resetBtn = null;

  /**
   * Store the selected file when user picks one. FormData is created only
   * at analyze time (after file selection), and we append this file with key "file".
   */
  let selectedFile = null;

  /**
   * Safely show a section and hide others. Uses display: none/block to avoid
   * animation-related DOM issues. Defensive null checks prevent throws.
   */
  function showSection(section) {
    try {
      if (uploadSection) uploadSection.style.display = section === "upload" ? "" : "none";
      if (scanningSection) scanningSection.style.display = section === "scanning" ? "" : "none";
      if (resultsSection) resultsSection.style.display = section === "results" ? "" : "none";
    } catch (e) {
      console.warn("[ResumeLens] showSection:", e);
    }
  }

  /**
   * Populate a list element with items. Clears existing children first.
   * @param {HTMLElement | null} listEl
   * @param {string[]} items
   * @param {string} emptyMessage
   */
  function fillList(listEl, items, emptyMessage) {
    if (!listEl) return;
    listEl.innerHTML = "";
    if (!items || !Array.isArray(items) || items.length === 0) {
      const li = document.createElement("li");
      li.textContent = emptyMessage;
      li.className = "empty-message";
      listEl.appendChild(li);
      return;
    }
    items.forEach((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      listEl.appendChild(li);
    });
  }

  /**
   * Update the circular ATS meter. Uses stroke-dasharray / stroke-dashoffset.
   * Circle r=85 => circumference ≈ 534. Clamp score to 0–100.
   */
  function updateMeter(score) {
    if (!meterProgress || !atsScoreEl) return;
    const n = Math.max(0, Math.min(100, Number(score)));
    const r = 85;
    const circumference = 2 * Math.PI * r;
    const offset = circumference * (1 - n / 100);
    try {
      meterProgress.setAttribute("stroke-dasharray", String(circumference));
      meterProgress.setAttribute("stroke-dashoffset", String(offset));
    } catch (e) {
      console.warn("[ResumeLens] updateMeter:", e);
    }
    atsScoreEl.textContent = String(Math.round(n));
  }

  /**
   * Display analysis result from backend format:
   * { success: true, data: { atsScore, skillsFound, missingSkills, suggestions } }
   */
  function displayResults(data) {
    if (!data || typeof data !== "object") return;
    const ats = data.atsScore;
    const found = data.skillsFound;
    const missing = data.missingSkills;
    const suggestions = data.suggestions;

    updateMeter(ats);
    fillList(foundSkillsList, found, "No skills detected.");
    fillList(missingSkillsList, missing, "None identified.");
    fillList(suggestionsList, suggestions, "No recommendations.");
    showSection("results");
  }

  /**
   * Show backend or network error to user. Use backend message when available;
   * otherwise avoid generic "Unable to fetch" and describe the failure.
   */
  function showError(message) {
    const msg =
      typeof message === "string" && message.length
        ? message
        : "An unexpected error occurred. Please try again.";
    try {
      alert(msg);
    } catch (e) {
      console.error("[ResumeLens] showError:", e);
    }
  }

  /**
   * 1. Capture file from input.
   * 2. Create FormData ONLY after file selection (at analyze time).
   * 3. Append file with key exactly "file" (multer upload.single("file")).
   * 4. Send fetch WITHOUT setting Content-Type (browser sets multipart/form-data + boundary).
   * 5. Handle response using result.data; surface backend error messages.
   */
  async function runAnalysis() {
    if (!selectedFile) {
      showError("Please select a resume file first.");
      return;
    }

    // Create FormData only after file selection, right before send
    const formData = new FormData();
    formData.append("file", selectedFile);

    console.log("[ResumeLens] FormData sent: key 'file', file:", {
      name: selectedFile.name,
      size: selectedFile.size,
      type: selectedFile.type,
    });

    showSection("scanning");
    if (scanningStatus) scanningStatus.textContent = "Extracting content and keywords";

    let res;
    let json;

    try {
      // Do NOT set Content-Type; fetch uses multipart/form-data with boundary automatically
      res = await fetch(ANALYZE_ENDPOINT, {
        method: "POST",
        body: formData,
        // Omitting headers ensures browser sets Content-Type correctly for FormData
      });
    } catch (err) {
      console.error("[ResumeLens] Backend request failed:", err);
      showSection("upload");
      const networkMsg =
        err && err.message
          ? "Network error: " + err.message
          : "Could not reach the backend. Is the server running at " + API_BASE + "?";
      showError(networkMsg);
      return;
    }

    try {
      // Production-safe JSON parsing:
      // - Avoid manual res.text() + JSON.parse() which can be brittle with proxies/CDNs.
      // - Use the browser's native JSON parser so we reliably handle streamed/chunked responses.
      json = await res.json();
    } catch (e) {
      console.error("[ResumeLens] Failed to parse JSON response:", e);
      showSection("upload");
      // Defensive, user-friendly error. Do not crash UI/animations.
      showError(
        "We couldn't read the server response. Please try again. If it persists, the server may be temporarily returning an invalid response."
      );
      return;
    }

    console.log("[ResumeLens] Backend response (parsed):", json);

    if (!res.ok) {
      showSection("upload");
      const msg =
        json && typeof json.message === "string"
          ? json.message
          : json && typeof json.error === "string"
            ? json.error
            : "Request failed with status " + res.status;
      showError(msg);
      return;
    }

    if (json && json.success === true && json.data) {
      displayResults(json.data);
      return;
    }

    if (json && json.success === false) {
      showSection("upload");
      showError(
        typeof json.message === "string" ? json.message : "Analysis failed."
      );
      return;
    }

    showSection("upload");
    showError("Unexpected response format. Expected { success, data }.");
  }

  function onFileChange() {
    const input = resumeInput;
    if (!input || !input.files || !input.files.length) {
      selectedFile = null;
      if (fileInfo) fileInfo.textContent = "";
      if (analyzeBtn) analyzeBtn.disabled = true;
      return;
    }

    const file = input.files[0];
    selectedFile = file;
    console.log("[ResumeLens] File selected:", {
      name: file.name,
      size: file.size,
      type: file.type,
    });

    if (fileInfo) fileInfo.textContent = file.name + " (" + formatBytes(file.size) + ")";
    if (analyzeBtn) analyzeBtn.disabled = false;
  }

  function formatBytes(n) {
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
    if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
    return n + " B";
  }

  function onReset() {
    selectedFile = null;
    const input = resumeInput;
    if (input) input.value = "";
    if (fileInfo) fileInfo.textContent = "";
    if (analyzeBtn) analyzeBtn.disabled = true;
    showSection("upload");
  }

  function bindElements() {
    resumeInput = document.getElementById("resumeInput");
    fileInfo = document.getElementById("fileInfo");
    analyzeBtn = document.getElementById("analyzeBtn");
    uploadSection = document.getElementById("uploadSection");
    scanningSection = document.getElementById("scanningSection");
    resultsSection = document.getElementById("resultsSection");
    scanningStatus = document.getElementById("scanningStatus");
    meterProgress = document.getElementById("meterProgress");
    atsScoreEl = document.getElementById("atsScore");
    foundSkillsList = document.getElementById("foundSkillsList");
    missingSkillsList = document.getElementById("missingSkillsList");
    suggestionsList = document.getElementById("suggestionsList");
    resetBtn = document.getElementById("resetBtn");
  }

  function init() {
    try {
      bindElements();
      if (!resumeInput) {
        console.error("[ResumeLens] #resumeInput not found.");
        return;
      }

      resumeInput.addEventListener("change", onFileChange);

      if (analyzeBtn) {
        analyzeBtn.addEventListener("click", function () {
          runAnalysis().catch((err) => {
            console.error("[ResumeLens] runAnalysis error:", err);
            showSection("upload");
            showError(err && err.message ? err.message : "Analysis failed.");
          });
        });
      }

      if (resetBtn) resetBtn.addEventListener("click", onReset);

      showSection("upload");
    } catch (e) {
      console.error("[ResumeLens] init error (animation or DOM):", e);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
