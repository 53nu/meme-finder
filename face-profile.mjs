import { expressions } from './ranking.mjs';

const MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';

export async function loadFaceModels(api) {
  await Promise.all([
    api.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
    api.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
    api.nets.faceExpressionNet.loadFromUri(MODEL_URL),
  ]);
  return api;
}

function center(points) {
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
}

function measureLandmarks(landmarks) {
  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();
  const left = center(leftEye);
  const right = center(rightEye);
  const origin = center([left, right]);
  const spread = Math.hypot(right.x - left.x, right.y - left.y);
  if (spread < 1) return null;
  const horizontal = { x: (right.x - left.x) / spread, y: (right.y - left.y) / spread };
  const x = point => (point.x - origin.x) * horizontal.x + (point.y - origin.y) * horizontal.y;
  const y = point => (point.y - origin.y) * horizontal.x - (point.x - origin.x) * horizontal.y;
  const mouth = landmarks.getMouth();
  const mouthWidth = Math.max(1, Math.abs(x(mouth[6]) - x(mouth[0])));
  const eyeWidth = eye => Math.max(1, Math.abs(x(eye[3]) - x(eye[0])));
  const eyeOpening = eye => (Math.abs(y(eye[5]) - y(eye[1])) + Math.abs(y(eye[4]) - y(eye[2]))) / (2 * eyeWidth(eye));
  const leftWidth = eyeWidth(leftEye);
  const rightWidth = eyeWidth(rightEye);
  return {
    spread,
    turn: Math.abs(x(landmarks.getNose()[3])) / spread,
    eyeSizeRatio: Math.min(leftWidth, rightWidth) / Math.max(leftWidth, rightWidth),
    shape: {
      mouthOpen: (Math.abs(y(mouth[19]) - y(mouth[13])) + Math.abs(y(mouth[18]) - y(mouth[14])) + Math.abs(y(mouth[17]) - y(mouth[15]))) / (3 * mouthWidth),
      mouthCorners: (y(center([mouth[3], mouth[9]])) - y(center([mouth[0], mouth[6]]))) / mouthWidth,
      eyeOpen: (eyeOpening(leftEye) + eyeOpening(rightEye)) / 2,
      browLift: -y(center([...landmarks.getLeftEyeBrow(), ...landmarks.getRightEyeBrow()])) / spread,
    },
  };
}

export async function describePhoto(frame, api, { catalog = false } = {}) {
  const faces = await api.detectAllFaces(frame, new api.SsdMobilenetv1Options({
    minConfidence: 0.62,
    maxResults: 6,
  })).withFaceLandmarks(true).withFaceExpressions();
  if (!faces.length) return { status: 'missing' };

  const area = face => face.detection.box.width * face.detection.box.height;
  faces.sort((left, right) => area(right) - area(left));
  const first = faces[0];
  const box = first.detection.box;
  const faceArea = area(first) / (frame.width * frame.height);
  const info = {
    confidence: first.detection.score,
    faceArea,
    count: faces.length,
    box: [box.x / frame.width, box.y / frame.height, box.width / frame.width, box.height / frame.height],
  };
  if (faces.slice(1).some(face => area(face) >= area(first) * (catalog ? 0.22 : 0.42))) return { status: 'multiple', ...info };
  if (faceArea < (catalog ? 0.052 : 0.028) || box.width < 40) return { status: 'small', ...info };

  const measured = measureLandmarks(first.landmarks);
  if (!measured || measured.turn > (catalog ? 0.34 : 0.46) || measured.eyeSizeRatio < (catalog ? 0.48 : 0.39)) {
    return { status: 'turned', ...info };
  }
  if (measured.spread < (catalog ? 21 : 17) || first.detection.score < (catalog ? 0.82 : 0.72)) {
    return { status: 'unclear', ...info };
  }

  const scores = Object.fromEntries(Object.keys(expressions).map(name => [name, first.expressions[name]]));
  return { status: 'ok', ...info, scores, shape: measured.shape };
}
