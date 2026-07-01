export function scoreForStatus(status) {
  if (status === 'OK') return 10;
  if (status === 'Warning') return 5;
  if (status === 'Error') return 1;
  return null;
}

export function computeScores(results) {
  const scoresFor = (auditType) => {
    const rows = results.filter((row) => row.auditType === auditType && row.score !== null && row.score !== undefined);
    if (!rows.length) return null;
    return weightedScore(rows);
  };

  const techScore = scoresFor('tech');
  const geoScore = scoresFor('geo');
  const allRows = results.filter((row) => row.score !== null && row.score !== undefined);
  const overallScore = allRows.length ? weightedScore(allRows) : null;

  return { techScore, geoScore, overallScore };
}

function weightedScore(rows) {
  let weightedTotal = 0;
  let weightedMax = 0;
  for (const row of rows) {
    const weight = scoreWeight(row);
    weightedTotal += Number(row.score) * weight;
    weightedMax += 10 * weight;
  }
  return weightedMax ? Math.round((weightedTotal / weightedMax) * 100) : null;
}

function scoreWeight(row) {
  const type = row.normalizedFindingType || row.findingType || 'core_issue';
  const text = `${row.checkId || ''} ${row.category || ''}`.toLowerCase();
  if (type === 'opportunity' || row.auditType === 'geo' || /geo|ai crawler|ai bot|speakable|llms|webmanifest|pwa/.test(text)) return 0.35;
  if (type === 'best_practice' || /security/.test(text)) return 0.5;
  if (type === 'info') return 0.2;
  return 1;
}

export function statusFromAffected(affectedCount, warningOnly = false) {
  if (affectedCount > 0) return warningOnly ? 'Warning' : 'Error';
  return 'OK';
}
