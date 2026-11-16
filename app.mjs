import { explainMatch, expressions, rankMemes, topExpression } from './ranking.mjs';
import { describePhoto, loadFaceModels } from './face-profile.mjs';

const FACE_GUIDANCE = {
  missing: '얼굴을 찾지 못했어요. 얼굴이 밝고 선명하게 나오도록 찍어 주세요.',
  multiple: '얼굴이 여러 개 보여요. 한 사람만 중앙에 두고 다시 찍어 주세요.',
  small: '얼굴이 작게 나왔어요. 카메라에 조금 더 가까이 와 주세요.',
  turned: '눈과 입이 잘 보이도록 카메라를 정면으로 보고 찍어 주세요.',
  unclear: '눈과 입을 충분히 읽기 어려워요. 빛이 잘 드는 곳에서 다시 찍어 주세요.',
};
const byId = id => document.getElementById(id);
const ui = {
  camera: byId('camera-button'),
  action: byId('camera-action'),
  label: byId('camera-label'),
  placeholder: byId('camera-placeholder'),
  status: byId('status-message'),
  upload: byId('image-upload'),
  uploadButton: byId('upload-button'),
  timerControl: byId('timer-control'),
  timerButton: byId('timer-button'),
  timerOptions: byId('timer-options'),
  timerValue: byId('timer-value'),
  countdown: byId('capture-countdown'),
  matchGrid: byId('match-grid'),
  matchMessage: byId('match-message'),
  comparison: byId('comparison'),
  comparisonPicker: byId('comparison-picker'),
  comparisonContent: byId('comparison-content'),
};
const matchPanel = ui.matchGrid.closest('section');
let memes = [];
let modelPromise;
let cameraStream;
let video;
let currentFrame;
let frameIsMirrored = false;
let busy = false;
let sketch;
let timerSeconds = 3;
let captureTimeout = null;

function setStatus(message, error = false) {
  ui.status.textContent = message;
  ui.status.hidden = !message;
  ui.status.dataset.error = String(error);
}

function updateControls() {
  const countingDown = captureTimeout !== null;
  ui.camera.disabled = busy;
  ui.uploadButton.disabled = busy || countingDown;
  ui.timerButton.disabled = busy || countingDown;
  ui.action.textContent = countingDown ? '촬영 취소' : cameraStream ? '촬영하고 찾기' : '카메라 켜기';
  matchPanel.setAttribute('aria-busy', String(busy));
}

function setTimerOpen(open) {
  ui.timerOptions.hidden = !open;
  ui.timerButton.setAttribute('aria-expanded', String(open));
}

function selectTimer(option) {
  timerSeconds = Number(option.dataset.delay);
  ui.timerValue.textContent = option.textContent;
  ui.timerButton.setAttribute('aria-label', '촬영 타이머, ' + option.textContent);
  for (const button of ui.timerOptions.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button === option));
  }
  setTimerOpen(false);
  ui.timerButton.focus();
}

function clearCountdown() {
  clearTimeout(captureTimeout);
  captureTimeout = null;
  ui.countdown.hidden = true;
  updateControls();
}

function startCountdown() {
  setStatus('');
  if (!timerSeconds) {
    void run(() => analyze(video, true));
    return;
  }
  const deadline = performance.now() + timerSeconds * 1000;
  const tick = () => {
    const milliseconds = deadline - performance.now();
    if (milliseconds <= 0) {
      clearCountdown();
      void run(() => analyze(video, true));
      return;
    }
    const remaining = Math.ceil(milliseconds / 1000);
    ui.countdown.textContent = String(remaining);
    ui.countdown.hidden = false;
    captureTimeout = setTimeout(tick, Math.max(16, milliseconds - (remaining - 1) * 1000));
  };
  tick();
  updateControls();
}

function setImageSource(frame, mirror = false) {
  currentFrame = frame;
  frameIsMirrored = mirror;
  ui.placeholder.hidden = !!frame;
}

function setupCanvas() {
  if (sketch) return;
  if (!globalThis.p5) throw new Error('p5.js를 불러오지 못했어요. 연결을 확인하고 새로고침해 주세요.');
  sketch = new globalThis.p5(p => {
    p.setup = () => {
      p.pixelDensity(1);
      const canvas = p.createCanvas(720, 500);
      canvas.elt.setAttribute('aria-hidden', 'true');
    };
    p.draw = () => {
      p.clear();
      if (!currentFrame) return;
      const width = currentFrame.videoWidth || currentFrame.naturalWidth || currentFrame.width;
      const height = currentFrame.videoHeight || currentFrame.naturalHeight || currentFrame.height;
      if (!width || !height) return;
      const scale = Math.max(p.width / width, p.height / height);
      const drawnWidth = width * scale;
      const drawnHeight = height * scale;
      const context = p.drawingContext;
      context.save();
      if (frameIsMirrored) {
        context.translate(p.width, 0);
        context.scale(-1, 1);
      }
      context.drawImage(currentFrame, (p.width - drawnWidth) / 2, (p.height - drawnHeight) / 2, drawnWidth, drawnHeight);
      context.restore();
    };
  }, 'canvas-host');
}

function stopCamera() {
  cameraStream?.getTracks().forEach(track => track.stop());
  if (video) {
    if (currentFrame === video) setImageSource(null);
    video.srcObject = null;
  }
  cameraStream = null;
  video = null;
  ui.label.textContent = currentFrame ? '사진' : '꺼짐';
  clearCountdown();
}

async function startCamera() {
  setupCanvas();
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('이 창에서 카메라를 쓸 수 없어요. 브라우저에서 페이지를 열거나 사진을 올려주세요.');
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 } },
      audio: false,
    });
    video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.srcObject = cameraStream;
    await video.play();
  } catch (error) {
    stopCamera();
    const message = error.name === 'NotAllowedError'
      ? '카메라 사용이 차단됐어요. 브라우저 권한을 확인하거나 사진을 올려주세요.'
      : '카메라를 열지 못했어요. 연결을 확인하거나 사진을 올려주세요.';
    throw new Error(message);
  }
  const stream = cameraStream;
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (cameraStream === stream) {
      stopCamera();
      setStatus('카메라 연결이 끊겼어요. 다시 켜거나 사진을 올려주세요.', true);
    }
  }, { once: true });
  setImageSource(video, true);
  ui.label.textContent = '켜짐';
  setStatus('');
  getModel().catch(() => {});
}

function getModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      const api = globalThis.faceapi;
      if (!api) throw new Error('표정 분석 라이브러리를 불러오지 못했어요. 연결을 확인하고 새로고침해 주세요.');
      try {
        return await loadFaceModels(api);
      } catch {
        throw new Error('표정 모델을 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
      }
    })().catch(error => {
      modelPromise = undefined;
      throw error;
    });
  }
  return modelPromise;
}

function readImage(url, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const finish = error => {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      if (error) reject(error);
      else resolve(img);
    };
    const timer = setTimeout(() => finish(new Error('이미지를 불러오는 데 시간이 걸리고 있어요.')), timeout);
    img.onload = () => finish();
    img.onerror = () => finish(new Error('이미지를 열 수 없어요.'));
    img.src = url;
  });
}

function copyFrame(frame, limit = 640) {
  const sourceWidth = frame.videoWidth || frame.naturalWidth || frame.width;
  const sourceHeight = frame.videoHeight || frame.naturalHeight || frame.height;
  const ratio = Math.min(1, limit / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceWidth * ratio));
  canvas.height = Math.max(1, Math.round(sourceHeight * ratio));
  canvas.getContext('2d').drawImage(frame, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function textElement(tag, className, value) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = value;
  return element;
}

function drawMemes(entries, ranked = false) {
  ui.matchGrid.replaceChildren(...entries.map((meme, index) => {
    const card = document.createElement('a');
    card.className = 'meme-card';
    card.href = meme.source;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';

    const media = document.createElement('div');
    media.className = 'meme-media';
    const fallback = textElement('span', 'meme-fallback', meme.label);
    const photo = document.createElement('img');
    photo.className = 'meme-image';
    photo.alt = meme.label;
    photo.addEventListener('load', () => { fallback.hidden = true; }, { once: true });
    photo.addEventListener('error', () => { photo.hidden = true; }, { once: true });
    photo.src = meme.image;
    media.append(fallback, photo);
    if (ranked) media.append(textElement('span', 'rank-number', String(index + 1)));

    card.append(media);
    return card;
  }));
}

function percent(score) {
  if (score > 0 && score < 0.001) return '<0.1%';
  if (score > 0.999 && score < 1) return '>99.9%';
  return (score * 100).toFixed(1) + '%';
}

function scoreCell(score, variant) {
  const cell = document.createElement('td');
  const track = document.createElement('span');
  track.className = 'score-track ' + variant;
  track.setAttribute('aria-hidden', 'true');
  const bar = document.createElement('span');
  bar.style.width = score * 100 + '%';
  track.append(bar);
  cell.append(track, textElement('span', 'score-value', percent(score)));
  return cell;
}

function compareScores(photo, meme, rank) {
  const reason = textElement('p', 'match-reason', explainMatch(photo, meme));
  const table = document.createElement('table');
  table.className = 'score-table';
  const head = table.createTHead().insertRow();
  for (const label of ['표정', '내 사진', rank + '위 짤']) {
    const cell = textElement('th', '', label);
    cell.scope = 'col';
    head.append(cell);
  }
  const rows = table.createTBody();
  for (const [key, label] of Object.entries(expressions)) {
    const name = textElement('th', '', label);
    name.scope = 'row';
    rows.insertRow().append(name, scoreCell(photo.scores[key], 'self'), scoreCell(meme.scores[key], 'candidate'));
  }
  const rule = textElement('p', 'match-rule', '표정 점수 55%, 눈·입·눈썹 모양 45%를 반영해요.');
  ui.comparisonContent.replaceChildren(reason, table, rule);
}

function setMatchMessage(message) {
  ui.matchMessage.textContent = message;
  ui.matchMessage.hidden = !message;
}

function showMatches(photo) {
  const matches = rankMemes(photo, memes);
  const match = expressions[topExpression(photo.scores)];
  drawMemes(matches, true);
  ui.matchGrid.setAttribute('aria-label', '감지한 표정 ' + match + ', 추천 밈 ' + matches.length + '장');
  setStatus('');
  if (!matches.length) {
    setMatchMessage('비슷한 표정의 짤을 찾지 못했어요. 다른 표정으로 한 번 더 찍어 보세요.');
    return;
  }
  if (matches.length < 3) setMatchMessage('표정이 가까운 짤 ' + matches.length + '장만 표시했어요.');
  const picker = matches.map((meme, index) => {
    const choice = textElement('button', 'comparison-choice', index + 1 + '위');
    choice.type = 'button';
    choice.setAttribute('aria-label', index + 1 + '위, ' + meme.label);
    choice.setAttribute('aria-pressed', String(index === 0));
    choice.addEventListener('click', () => {
      for (const button of picker) button.setAttribute('aria-pressed', String(button === choice));
      compareScores(photo, meme, index + 1);
    });
    return choice;
  });
  ui.comparisonPicker.replaceChildren(...picker);
  compareScores(photo, matches[0], 1);
  ui.comparison.hidden = false;
}

async function analyze(frame, mirror = false) {
  if (!frame || (mirror && !frame.videoWidth)) throw new Error('카메라가 준비 중이에요. 잠시 뒤 다시 눌러주세요.');
  if (!memes.length) throw new Error('밈 목록을 준비하고 있어요. 잠시 뒤 다시 시도해 주세요.');
  ui.matchGrid.replaceChildren();
  ui.matchGrid.removeAttribute('aria-label');
  ui.comparison.hidden = true;
  setMatchMessage('');
  setStatus('얼굴 표정을 분석하고 있어요…');
  const image = copyFrame(frame);
  setImageSource(image, mirror);
  const api = await getModel();
  const photo = await describePhoto(image, api);
  if (photo.status !== 'ok') {
    if (video) setImageSource(video, true);
    throw new Error(FACE_GUIDANCE[photo.status]);
  }
  showMatches(photo);
}

async function run(action) {
  if (busy) return;
  busy = true;
  updateControls();
  try {
    await action();
  } catch (error) {
    setStatus(error?.message || '문제가 생겼어요. 다시 시도해 주세요.', true);
  } finally {
    busy = false;
    updateControls();
  }
}

ui.camera.addEventListener('click', () => {
  setTimerOpen(false);
  if (captureTimeout !== null) {
    clearCountdown();
    return;
  }
  if (!video) {
    void run(async () => {
      setStatus('브라우저에서 카메라 사용을 허용해 주세요.');
      await startCamera();
    });
    return;
  }
  setImageSource(video, true);
  startCountdown();
});
ui.timerButton.addEventListener('click', () => {
  const open = ui.timerOptions.hidden;
  setTimerOpen(open);
  if (open) ui.timerOptions.querySelector('[aria-pressed="true"]').focus();
});
ui.timerOptions.addEventListener('click', event => {
  const option = event.target.closest('button[data-delay]');
  if (option) selectTimer(option);
});
ui.timerControl.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !ui.timerOptions.hidden) {
    setTimerOpen(false);
    ui.timerButton.focus();
  }
});
document.addEventListener('click', event => {
  if (!ui.timerControl.contains(event.target)) setTimerOpen(false);
});
ui.uploadButton.addEventListener('click', () => ui.upload.click());
ui.upload.addEventListener('change', () => {
  const file = ui.upload.files[0];
  ui.upload.value = '';
  if (!file) return;
  run(async () => {
    setupCanvas();
    const url = URL.createObjectURL(file);
    try {
      const image = await readImage(url, 10000);
      stopCamera();
      await analyze(image);
      ui.label.textContent = '사진';
    } finally {
      URL.revokeObjectURL(url);
    }
  });
});
window.addEventListener('pagehide', stopCamera);

updateControls();
fetch('./memes.json').then(response => {
  if (!response.ok) throw new Error('컬렉션을 불러오지 못했어요.');
  return response.json();
}).then(entries => {
  memes = entries;
  drawMemes(memes.slice(0, 3));
  updateControls();
}).catch(error => setStatus(error.message, true));
