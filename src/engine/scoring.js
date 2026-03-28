function calculateAccuracy(target, player) {
  if (!target || !player || target.length !== player.length) return 0;
  let correct = 0;
  for (let i = 0; i < target.length; i++) {
    if (target[i] === player[i]) correct++;
  }
  return correct / target.length;
}

function scoreRound(accuracy, timeMs, memTime) {
  const accScore = Math.round(accuracy * 700);
  const maxRecallTime = memTime * 4;
  const speedBonus = Math.max(
    0,
    Math.round((1 - timeMs / maxRecallTime) * 300)
  );
  return accScore + speedBonus;
}

module.exports = { calculateAccuracy, scoreRound };
