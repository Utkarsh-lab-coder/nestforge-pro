/*
 * NestForge Pro — PART_COLORS palette + nextColor helper
 *
 * Original location: lines 13778..13786 of nestforge-pro.html (9 lines)
 *
 * This file is loaded by index.html as a plain <script> tag — no module
 * system. Globals it defines attach to window. Order in index.html
 * matters: dependencies (e.g. PU, NFP) must be loaded before consumers.
 */

const PART_COLORS = [
  '#f97316','#3b82f6','#22c55e','#ec4899','#a855f7',
  '#06b6d4','#eab308','#ef4444','#14b8a6','#f43f5e',
  '#84cc16','#8b5cf6','#fb923c','#60a5fa','#4ade80'
];

let colorIdx = 0;
function nextColor() { return PART_COLORS[colorIdx++ % PART_COLORS.length]; }


