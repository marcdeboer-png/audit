export function nowIso() {
  return new Date().toISOString();
}

export function elapsedSeconds(startedAt, finishedAt = null) {
  if (!startedAt) return 0;
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  return Math.max(0, Math.floor((end - new Date(startedAt).getTime()) / 1000));
}

export function pagesPerMinute(processedUrls, startedAt, finishedAt = null) {
  const seconds = elapsedSeconds(startedAt, finishedAt);
  if (!seconds) return 0;
  return Number(((processedUrls / seconds) * 60).toFixed(1));
}

export function estimatedRemainingSeconds(discoveredUrls, processedUrls, ppm) {
  if (!ppm || processedUrls <= 0 || discoveredUrls <= processedUrls) return null;
  return Math.round(((discoveredUrls - processedUrls) / ppm) * 60);
}
