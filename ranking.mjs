export const expressions = {
  neutral: '무표정',
  happy: '웃음',
  sad: '울상',
  angry: '화남',
  fearful: '겁먹음',
  disgusted: '찡그림',
  surprised: '놀람',
};

const shapeFeatures = {
  mouthOpen: { label: '입을 벌린 정도', scale: 0.24, weight: 0.36 },
  mouthCorners: { label: '입꼬리 높이', scale: 0.16, weight: 0.25 },
  eyeOpen: { label: '눈을 뜬 정도', scale: 0.14, weight: 0.24 },
  browLift: { label: '눈썹 높이', scale: 0.13, weight: 0.15 },
};

export function topExpression(scores) {
  return Object.keys(expressions).reduce((top, name) =>
    (scores[name] ?? 0) > (scores[top] ?? 0) ? name : top, 'neutral');
}

function featureGaps(left, right) {
  return Object.entries(shapeFeatures).map(([key, feature]) => ({
    ...feature,
    gap: Math.min(1, Math.abs(left[key] - right[key]) / feature.scale),
  }));
}

function matchDistance(photo, meme) {
  const squaredDifference = Object.keys(expressions).reduce((total, name) =>
    total + (Math.sqrt(photo.scores[name]) - Math.sqrt(meme.scores[name])) ** 2, 0);
  const expression = Math.sqrt(squaredDifference / 2);
  const shape = featureGaps(photo.shape, meme.shape).reduce((total, feature) => total + feature.gap * feature.weight, 0);
  return { overall: 0.55 * expression + 0.45 * shape, expression, shape };
}

export function rankMemes(photo, memes) {
  return memes.map(meme => ({ ...meme, distance: matchDistance(photo, meme) }))
    .filter(({ distance }) => distance.overall <= 0.39 && distance.expression <= 0.67 && distance.shape <= 0.53)
    .sort((left, right) => left.distance.overall - right.distance.overall)
    .slice(0, 3);
}

export function explainMatch(photo, meme) {
  const personal = topExpression(photo.scores);
  const candidate = topExpression(meme.scores);
  const scoreReason = personal === candidate
    ? '두 사진 모두 ‘' + expressions[personal] + '’ 점수가 가장 높아요.'
    : '내 사진은 ‘' + expressions[personal] + '’, 이 짤은 ‘' + expressions[candidate] + '’ 점수가 가장 높아요.';
  const closeFeature = featureGaps(photo.shape, meme.shape).sort((left, right) => left.gap - right.gap)[0];
  return closeFeature.gap > 0.22 ? scoreReason : scoreReason + ' 특히 ‘' + closeFeature.label + '’가 비슷해요.';
}
