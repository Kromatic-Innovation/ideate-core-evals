// plot.mjs — hand-emitted SVG for the cost/diversity Pareto frontier. No
// plotting library: the repo has zero runtime dependencies (#46
// non-negotiable), and a scatter plot with axes and labelled points is
// simple enough to emit as a template string without one.

const WIDTH = 640;
const HEIGHT = 440;
const MARGIN = { top: 24, right: 24, bottom: 56, left: 64 };

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch]));
}

/**
 * Render the Pareto frontier as a standalone SVG scatter: cost on x, response
 * (e.g. mean distinct_k) on y, points labelled by armId, frontier points
 * connected and visually distinguished from dominated ones.
 *
 * @param {Array<{armId: string, meanCostUsd: number, meanResponse: number, onFrontier: boolean}>} points
 *   the output of pareto.mjs:paretoFrontier()
 * @param {object} [opts]
 *   @param {string} [opts.title="Cost / Diversity Pareto Frontier"]
 *   @param {string} [opts.xLabel="Mean cost (USD)"]
 *   @param {string} [opts.yLabel="Mean distinct_k"]
 * @returns {string} a complete <svg>...</svg> document
 */
export function renderParetoSvg(points, opts = {}) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error("renderParetoSvg: points must be a non-empty array");
  }
  const title = opts.title || "Cost / Diversity Pareto Frontier";
  const xLabel = opts.xLabel || "Mean cost (USD)";
  const yLabel = opts.yLabel || "Mean distinct_k";

  const xs = points.map((p) => p.meanCostUsd);
  const ys = points.map((p) => p.meanResponse);
  const xMin = 0, xMax = Math.max(...xs) * 1.1 || 1;
  const yMin = 0, yMax = Math.max(...ys) * 1.1 || 1;

  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const sx = (x) => MARGIN.left + (plotW * (x - xMin)) / (xMax - xMin);
  const sy = (y) => MARGIN.top + plotH - (plotH * (y - yMin)) / (yMax - yMin);

  const frontierPoints = points
    .filter((p) => p.onFrontier)
    .slice()
    .sort((a, b) => a.meanCostUsd - b.meanCostUsd);

  const frontierPath = frontierPoints.length > 1
    ? `<polyline points="${frontierPoints.map((p) => `${sx(p.meanCostUsd)},${sy(p.meanResponse)}`).join(" ")}" fill="none" stroke="#2563eb" stroke-width="2" />`
    : "";

  const circles = points
    .map((p) => {
      const cx = sx(p.meanCostUsd);
      const cy = sy(p.meanResponse);
      const fill = p.onFrontier ? "#2563eb" : "#9ca3af";
      return (
        `<circle cx="${cx}" cy="${cy}" r="5" fill="${fill}" data-arm="${escapeXml(p.armId)}" ` +
        `data-cost="${p.meanCostUsd}" data-response="${p.meanResponse}" data-on-frontier="${p.onFrontier}" />` +
        `<text x="${cx + 8}" y="${cy - 8}" font-size="12" font-family="sans-serif">${escapeXml(p.armId)}</text>`
      );
    })
    .join("\n  ");

  const xTicks = 5;
  const xAxisTicks = Array.from({ length: xTicks + 1 }, (_, i) => {
    const x = xMin + ((xMax - xMin) * i) / xTicks;
    const px = sx(x);
    return `<line x1="${px}" y1="${MARGIN.top + plotH}" x2="${px}" y2="${MARGIN.top + plotH + 4}" stroke="#374151" />` +
      `<text x="${px}" y="${MARGIN.top + plotH + 18}" font-size="10" font-family="sans-serif" text-anchor="middle">${x.toFixed(2)}</text>`;
  }).join("\n  ");

  const yTicks = 5;
  const yAxisTicks = Array.from({ length: yTicks + 1 }, (_, i) => {
    const y = yMin + ((yMax - yMin) * i) / yTicks;
    const py = sy(y);
    return `<line x1="${MARGIN.left - 4}" y1="${py}" x2="${MARGIN.left}" y2="${py}" stroke="#374151" />` +
      `<text x="${MARGIN.left - 8}" y="${py + 3}" font-size="10" font-family="sans-serif" text-anchor="end">${y.toFixed(1)}</text>`;
  }).join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeXml(title)}">
  <title>${escapeXml(title)}</title>
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#ffffff" />
  <text x="${WIDTH / 2}" y="16" font-size="14" font-family="sans-serif" text-anchor="middle" font-weight="bold">${escapeXml(title)}</text>
  <line x1="${MARGIN.left}" y1="${MARGIN.top}" x2="${MARGIN.left}" y2="${MARGIN.top + plotH}" stroke="#111827" />
  <line x1="${MARGIN.left}" y1="${MARGIN.top + plotH}" x2="${MARGIN.left + plotW}" y2="${MARGIN.top + plotH}" stroke="#111827" />
  ${xAxisTicks}
  ${yAxisTicks}
  <text x="${MARGIN.left + plotW / 2}" y="${HEIGHT - 8}" font-size="12" font-family="sans-serif" text-anchor="middle">${escapeXml(xLabel)}</text>
  <text x="14" y="${MARGIN.top + plotH / 2}" font-size="12" font-family="sans-serif" text-anchor="middle" transform="rotate(-90 14 ${MARGIN.top + plotH / 2})">${escapeXml(yLabel)}</text>
  ${frontierPath}
  ${circles}
</svg>
`;
}
