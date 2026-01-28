/**
 * analyzer.js
 *
 * Deterministic, rule-based ATS-style resume analysis.
 * No AI APIs. Beginner-friendly logic: keyword matching + simple heuristics.
 */

const DEFAULT_SKILLS = [
  // Programming / web
  "javascript",
  "typescript",
  "node",
  "express",
  "react",
  "html",
  "css",
  "rest",
  "api",
  "git",
  // Data / cloud
  "sql",
  "python",
  "java",
  "aws",
  "azure",
  "docker",
  "kubernetes",
  // Process
  "agile",
  "scrum",
  "jira",
  "testing",
  "unit testing",
  "ci/cd"
];

function normalize(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .toLowerCase();
}

function includesWord(text, word) {
  // Word boundary-ish match, but allow skills like "ci/cd"
  if (!word) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
  return rx.test(text);
}

function detectSections(text) {
  const sectionHints = [
    { key: "summary", labels: ["summary", "professional summary", "profile"] },
    { key: "experience", labels: ["experience", "work experience", "employment"] },
    { key: "education", labels: ["education", "academics"] },
    { key: "skills", labels: ["skills", "technical skills", "core skills"] },
    { key: "projects", labels: ["projects", "project experience"] }
  ];

  const found = new Set();
  for (const s of sectionHints) {
    for (const label of s.labels) {
      if (includesWord(text, label)) {
        found.add(s.key);
        break;
      }
    }
  }
  return Array.from(found);
}

function scoreFromHeuristics(text, skillsFound, missingSkills, sectionsFound) {
  let score = 0;

  // 1) Skill coverage (max 60)
  const totalSkills = skillsFound.length + missingSkills.length;
  const coverage = totalSkills === 0 ? 0 : skillsFound.length / totalSkills;
  score += Math.round(coverage * 60);

  // 2) Resume structure (max 25)
  // Encourage common sections. If present, add points.
  const sectionPoints = {
    summary: 5,
    experience: 10,
    education: 5,
    skills: 5,
    projects: 5
  };
  for (const key of Object.keys(sectionPoints)) {
    if (sectionsFound.includes(key)) score += sectionPoints[key];
  }
  score = Math.min(score, 60 + 25);

  // 3) Basic formatting signals (max 15)
  const hasBullets = /(^|\n)\s*[-•*]\s+\S+/m.test(text);
  const hasNumbers = /\b\d{4}\b/.test(text) || /\b\d+%|\b\d+\+/.test(text);
  const length = text.length;

  if (length >= 1200) score += 5; // not too short
  if (length >= 2500) score += 3; // more detail
  if (hasBullets) score += 4;
  if (hasNumbers) score += 3;

  return Math.max(0, Math.min(100, score));
}

/**
 * analyzeResume
 * @param {string} resumeText
 * @param {{ targetSkills?: string[] }} [options]
 * @returns {{ atsScore: number, skillsFound: string[], missingSkills: string[], suggestions: string[] }}
 */
function analyzeResume(resumeText, options = {}) {
  const text = normalize(resumeText);
  const targetSkills = Array.isArray(options.targetSkills) && options.targetSkills.length
    ? options.targetSkills
    : DEFAULT_SKILLS;

  const skillsFound = [];
  const missingSkills = [];

  for (const rawSkill of targetSkills) {
    const skill = String(rawSkill).trim().toLowerCase();
    if (!skill) continue;
    (includesWord(text, skill) ? skillsFound : missingSkills).push(rawSkill);
  }

  // Make output deterministic and clean
  const unique = (arr) =>
    Array.from(new Set(arr.map((s) => String(s).trim()))).filter(Boolean);

  const foundUnique = unique(skillsFound).sort((a, b) => a.localeCompare(b));
  const missingUnique = unique(missingSkills).sort((a, b) => a.localeCompare(b));

  const sectionsFound = detectSections(text);
  const atsScore = scoreFromHeuristics(text, foundUnique, missingUnique, sectionsFound);

  const suggestions = [];

  if (!sectionsFound.includes("skills")) {
    suggestions.push("Add a dedicated 'Skills' section with relevant keywords.");
  }
  if (!sectionsFound.includes("experience")) {
    suggestions.push("Add a 'Work Experience' section with role details and impact.");
  }
  if (!/(^|\n)\s*[-•*]\s+\S+/m.test(text)) {
    suggestions.push("Use bullet points for responsibilities and achievements.");
  }
  if (!(/\b\d+%|\b\d+\+|\b\d{4}\b/.test(text))) {
    suggestions.push("Add measurable results (%, numbers) and dates to strengthen impact.");
  }
  if (missingUnique.length > 0) {
    suggestions.push(
      "If relevant, include missing keywords naturally: " + missingUnique.slice(0, 8).join(", ") + (missingUnique.length > 8 ? ", ..." : "")
    );
  }
  if (text.length < 900) {
    suggestions.push("Add more detail (projects, tools, accomplishments) — the resume looks too short.");
  }

  return {
    atsScore,
    skillsFound: foundUnique,
    missingSkills: missingUnique,
    suggestions
  };
}

module.exports = { analyzeResume };

