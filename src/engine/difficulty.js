function getDifficulty(round) {
  if (round <= 1) return { grid: 4, colors: 2, time: 4500 };
  if (round <= 2) return { grid: 4, colors: 3, time: 4000 };
  if (round <= 3) return { grid: 5, colors: 3, time: 3500 };
  if (round <= 4) return { grid: 5, colors: 4, time: 3000 };
  return { grid: 5, colors: 4, time: 2500 };
}

module.exports = { getDifficulty };
