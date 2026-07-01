export const thresholds = Object.freeze({
  titleTooShort: 20,
  titleTooLong: 65,
  descriptionTooShort: 70,
  descriptionTooLong: 160,
  highTtfbMs: 800,
  largeHtmlKb: 250,
  tooManyJsResources: 25,
  tooManyCssResources: 15,
  largeJsTotalBytes: 1024 * 1024,
  largeCssTotalBytes: 300 * 1024,
  largeImageBytes: 300 * 1024,
  renderedRawWordCountRatio: 1.5,
  lighthousePerformanceWarning: 0.7,
  lighthousePerformanceError: 0.5,
  lighthouseSeoWarning: 0.8,
  lcpWarningMs: 2500,
  lcpErrorMs: 4000,
  tbtWarningMs: 200,
  tbtErrorMs: 600,
  clsWarning: 0.1,
  clsError: 0.25,
  consoleErrorsWarning: 1
});

export const thresholdBytes = Object.freeze({
  largeHtmlBytes: thresholds.largeHtmlKb * 1024
});
