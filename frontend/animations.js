/**
 * animations.js
 *
 * Why animations were not executing:
 * - This file was missing from /frontend, so index.html loaded a 404 and nothing ran.
 *
 * Fix:
 * - Provide ./animations.js and keep it defensive so it never blocks app logic.
 * - Does not touch backend integration or main.js event handlers.
 */

(function () {
  "use strict";

  // Never let animations crash the app.
  function safe(fn) {
    try {
      fn();
    } catch (e) {
      console.warn("[ResumeLens] animations.js error:", e);
    }
  }

  function animateOrbs() {
    const orbs = Array.from(document.querySelectorAll(".gradient-orb"));
    if (!orbs.length) return;

    let t0 = performance.now();

    function frame(t) {
      const dt = (t - t0) / 1000;
      // Gentle floating motion; purely visual.
      orbs.forEach((orb, i) => {
        const a = dt * (0.22 + i * 0.06);
        const x = Math.sin(a) * (18 + i * 6);
        const y = Math.cos(a * 0.9) * (14 + i * 5);
        orb.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      });
      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }

  function animateScanLine() {
    const scanLine = document.querySelector(".scan-line");
    if (!scanLine) return;

    let dir = 1;
    let y = 18;

    function tick() {
      // Move within the scanning box height.
      y += dir * 1.4;
      if (y > 62) dir = -1;
      if (y < 16) dir = 1;
      scanLine.style.top = `${y}px`;
      requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  }

  function animateProgressBar() {
    const scanningSection = document.getElementById("scanningSection");
    const fill = document.getElementById("progressFill");
    if (!scanningSection || !fill) return;

    let p = 0;
    let last = 0;

    function step(ts) {
      // Only animate while scanning section is visible.
      const isVisible =
        scanningSection.style.display !== "none" &&
        scanningSection.offsetParent !== null;

      if (!isVisible) {
        p = 0;
        fill.style.width = "0%";
        last = ts;
        requestAnimationFrame(step);
        return;
      }

      const dt = Math.min(0.05, (ts - (last || ts)) / 1000);
      last = ts;

      // Ease towards 92% while waiting for backend response.
      const target = 92;
      p += (target - p) * dt * 0.9;
      fill.style.width = `${Math.max(0, Math.min(100, p)).toFixed(1)}%`;

      requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      safe(animateOrbs);
      safe(animateScanLine);
      safe(animateProgressBar);
    });
  } else {
    safe(animateOrbs);
    safe(animateScanLine);
    safe(animateProgressBar);
  }
})();

