const { COLORS } = require("./constants");

function generatePattern(gridSize, colorCount) {
  const pool = COLORS.slice(0, colorCount);
  const total = gridSize * gridSize;
  const litCount =
    Math.floor(total * 0.4) +
    Math.floor(Math.random() * Math.ceil(total * 0.15));

  const pattern = Array(total).fill(null);
  const indices = Array.from({ length: total }, (_, i) => i)
    .sort(() => Math.random() - 0.5)
    .slice(0, litCount);

  indices.forEach((i) => {
    pattern[i] = pool[Math.floor(Math.random() * pool.length)];
  });

  return pattern;
}

module.exports = { generatePattern };
