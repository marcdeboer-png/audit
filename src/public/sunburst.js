export const maturityLegend = Object.freeze([
  { label: '0-1.9 Kritisch', color: 'var(--rg-1)' },
  { label: '2-3.9 Unausgereift', color: 'var(--rg-2)' },
  { label: '4-5.4 Basis vorhanden', color: 'var(--rg-4)' },
  { label: '5.5-6.9 Fortgeschritten', color: 'var(--rg-6)' },
  { label: '7-8.4 Stark', color: 'var(--rg-8)' },
  { label: '8.5-10 Top', color: 'var(--rg-10)' },
  { label: 'N/A Nicht bewertet', color: 'var(--rg-none)' }
]);

export function scoreToColor(score) {
  const numericScore = Number(score);
  if (score === null || score === undefined || Number.isNaN(numericScore)) return 'var(--rg-none)';
  if (numericScore < 2) return 'var(--rg-1)';
  if (numericScore < 4) return 'var(--rg-2)';
  if (numericScore < 5.5) return 'var(--rg-4)';
  if (numericScore < 7) return 'var(--rg-6)';
  if (numericScore < 8.5) return 'var(--rg-8)';
  return 'var(--rg-10)';
}

export function createSunburstSegments(categories = [], options = {}) {
  return createSunburstLayout(categories, options).categories;
}

export function createSunburstLayout(categories = [], options = {}) {
  const size = Number.isFinite(options.size) ? options.size : 900;
  const center = size / 2;
  const gap = Number.isFinite(options.gap) ? options.gap : 0.008;
  const itemGap = Number.isFinite(options.itemGap) ? options.itemGap : 0.003;
  const startAngle = Number.isFinite(options.startAngle) ? options.startAngle : -Math.PI / 2;
  const totalAngle = Number.isFinite(options.totalAngle) ? options.totalAngle : Math.PI * 2;
  const centerRadius = Number.isFinite(options.centerRadius) ? options.centerRadius : 60;
  const categoryOuterRadius = Number.isFinite(options.categoryOuterRadius) ? options.categoryOuterRadius : size * 0.27;
  const itemOuterRadius = Number.isFinite(options.itemOuterRadius) ? options.itemOuterRadius : size * 0.48;
  const visibleCategories = categories.filter((category) => category && category.name);
  const normalizedCategories = visibleCategories.map((category) => {
    const items = normalizeCategoryItems(category);
    return { category, items, layoutCount: Math.max(1, items.length) };
  });
  const totalItems = normalizedCategories.reduce((sum, item) => sum + item.layoutCount, 0);
  if (!totalItems) {
    return { size, center, centerRadius, categoryOuterRadius, itemOuterRadius, categories: [], items: [], totalItems: 0 };
  }

  const anglePerItem = (totalAngle - normalizedCategories.length * gap) / totalItems;
  let cursor = startAngle;
  const categorySegments = [];
  const itemSegments = [];

  for (const { category, items, layoutCount } of normalizedCategories) {
    const segmentStart = cursor;
    const segmentSweep = layoutCount * anglePerItem;
    const segmentEnd = segmentStart + segmentSweep;
    const score = normalizedScore(category.score, Number(category.evaluatedCount || 0) > 0);
    const categorySegment = {
      type: 'category',
      categoryId: category.id || category.name,
      name: category.name,
      score,
      maturityLabel: category.maturityLabel || (score === null ? 'Nicht bewertet' : ''),
      weight: Number(category.weight || 1),
      configuredWeight: category.weight,
      checkCount: Number(category.checkCount || 0),
      evaluatedCount: Number(category.evaluatedCount || 0),
      recommendation: category.recommendation || '',
      managementDescription: category.managementDescription || category.description || '',
      startAngle: segmentStart,
      endAngle: segmentEnd,
      midAngle: segmentStart + segmentSweep / 2,
      sweep: segmentSweep,
      itemCount: items.length,
      layoutItemCount: layoutCount,
      weightShare: roundOne((layoutCount / totalItems) * 100),
      color: scoreToColor(score),
      isEvaluated: score !== null
    };
    categorySegments.push(categorySegment);

    let itemCursor = segmentStart;
    for (const item of items) {
      const itemStart = itemCursor + itemGap / 2;
      const itemEnd = itemCursor + anglePerItem - itemGap / 2;
      const itemScore = normalizedScore(item.score, item.score !== null && item.score !== undefined);
      itemSegments.push({
        type: 'item',
        categoryId: categorySegment.categoryId,
        categoryName: category.name,
        id: item.id || item.label || categorySegment.categoryId,
        checkResultId: item.checkResultId || null,
        name: item.label || item.shortLabel || item.id || 'Check',
        shortLabel: item.shortLabel || truncate(item.label || item.id || 'Check', 28),
        score: itemScore,
        status: item.status || (itemScore === null ? 'NA' : ''),
        findingType: item.findingType || '',
        priority: item.priority || '',
        effort: item.effort || '',
        affectedCount: Number(item.affectedCount || 0),
        recommendation: item.recommendation || category.recommendation || '',
        finding: item.finding || '',
        confidence: item.confidence || '',
        reviewRecommended: Boolean(item.reviewRecommended),
        startAngle: itemStart,
        endAngle: itemEnd,
        midAngle: itemStart + (itemEnd - itemStart) / 2,
        sweep: itemEnd - itemStart,
        color: scoreToColor(itemScore),
        isFallback: Boolean(item.isFallback)
      });
      itemCursor += anglePerItem;
    }
    cursor = segmentEnd + gap;
  }

  return {
    size,
    center,
    centerRadius,
    categoryOuterRadius,
    itemOuterRadius,
    categoryInnerRadius: centerRadius,
    itemInnerRadius: categoryOuterRadius + 2,
    categories: categorySegments,
    items: itemSegments,
    totalItems,
    anglePerItem
  };
}

export function createWeightedSunburstSegments(categories = [], options = {}) {
  const gap = Number.isFinite(options.gap) ? options.gap : 0.008;
  const startAngle = Number.isFinite(options.startAngle) ? options.startAngle : -Math.PI / 2;
  const totalAngle = Number.isFinite(options.totalAngle) ? options.totalAngle : Math.PI * 2;
  const visibleCategories = categories.filter((category) => category && category.name);
  const weightedCategories = visibleCategories.map((category) => {
    const explicitWeight = Number(category.weight);
    const checkCount = Number(category.checkCount);
    const segmentWeight = explicitWeight > 0 ? explicitWeight : checkCount > 0 ? checkCount : 1;
    return { category, segmentWeight };
  });
  const totalWeight = weightedCategories.reduce((sum, item) => sum + item.segmentWeight, 0);
  if (!totalWeight) return [];

  const totalGap = Math.min(totalAngle * 0.2, Math.max(0, weightedCategories.length * Math.max(0, gap)));
  const anglePerWeight = (totalAngle - totalGap) / totalWeight;
  let cursor = startAngle;

  return weightedCategories.map(({ category, segmentWeight }) => {
    const sweep = segmentWeight * anglePerWeight;
    const segmentStart = cursor;
    const segmentEnd = cursor + sweep;
    cursor = segmentEnd + gap;
    const score = category.score === null || category.score === undefined ? null : Number(category.score);
    const isEvaluated = score !== null && !Number.isNaN(score) && Number(category.evaluatedCount || 0) > 0;
    return {
      categoryId: category.id || category.name,
      name: category.name,
      score: isEvaluated ? score : null,
      maturityLabel: category.maturityLabel || (isEvaluated ? '' : 'Nicht bewertet'),
      weight: segmentWeight,
      configuredWeight: category.weight,
      checkCount: Number(category.checkCount || 0),
      evaluatedCount: Number(category.evaluatedCount || 0),
      recommendation: category.recommendation || '',
      managementDescription: category.managementDescription || category.description || '',
      startAngle: segmentStart,
      endAngle: segmentEnd,
      midAngle: segmentStart + sweep / 2,
      sweep,
      weightShare: roundOne((segmentWeight / totalWeight) * 100),
      color: scoreToColor(isEvaluated ? score : null),
      isEvaluated
    };
  });
}

function normalizeCategoryItems(category = {}) {
  if (Array.isArray(category.items) && category.items.length) {
    return category.items.map((item) => ({
      ...item,
      label: item.label || item.name || item.checkId || item.id || 'Check',
      shortLabel: item.shortLabel || truncate(item.label || item.name || item.checkId || item.id || 'Check', 28)
    }));
  }
  if (Array.isArray(category.keyFindings) && category.keyFindings.length) {
    return category.keyFindings.map((item) => ({
      id: item.checkId || item.title,
      label: item.title || item.checkId || 'Finding',
      shortLabel: truncate(item.title || item.checkId || 'Finding', 28),
      score: category.score,
      status: item.status || '',
      findingType: item.findingType || '',
      priority: item.priority || '',
      affectedCount: Number(item.affectedCount || 0),
      recommendation: item.recommendation || category.recommendation || '',
      finding: item.finding || ''
    }));
  }
  return [{
    id: `${category.id || category.name || 'category'}-fallback`,
    label: 'Nicht bewertet',
    shortLabel: 'Nicht bewertet',
    score: null,
    status: 'NA',
    findingType: 'info',
    affectedCount: 0,
    recommendation: category.recommendation || '',
    isFallback: true
  }];
}

function normalizedScore(score, hasData) {
  const numericScore = Number(score);
  if (!hasData || score === null || score === undefined || Number.isNaN(numericScore)) return null;
  return numericScore;
}

function truncate(value, maxLength) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function sunburstArcPath(cx, cy, startAngle, endAngle, innerRadius, outerRadius) {
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const outerStart = polarToXY(cx, cy, startAngle, outerRadius);
  const outerEnd = polarToXY(cx, cy, endAngle, outerRadius);
  const innerEnd = polarToXY(cx, cy, endAngle, innerRadius);
  const innerStart = polarToXY(cx, cy, startAngle, innerRadius);
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    'Z'
  ].join(' ');
}

export function polarToXY(cx, cy, angle, radius) {
  return {
    x: roundTwo(cx + Math.cos(angle) * radius),
    y: roundTwo(cy + Math.sin(angle) * radius)
  };
}

function roundOne(value) {
  return Math.round(value * 10) / 10;
}

function roundTwo(value) {
  return Math.round(value * 100) / 100;
}
