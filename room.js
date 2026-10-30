import { sb, rpc, savedSecret, saveSecret, forgetSecret, VISIBILITY_LABEL } from './lib.js';
import { W, H, MAX_POINTS, renderStroke, isStroke } from './render.js';

const $ = (id) => document.getElementById(id);
const slug = new URLSearchParams(location.search).get('r') ?? '';
const PALETTE = ['#000000', '#ffffff', '#7f7f7f', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#00acc1', '#1e88e5', '#8e24aa', '#f48fb1', '#6d4c41'];
const LIVE_INTERVAL = 80;  // 描画途中の線を流す間隔（ms）
const ZOOM_MIN = 0.1, ZOOM_MAX = 16;
const MAX_LAYERS = 32;     // DB と合わせる

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 端末ごとの合言葉。自分の線を取り消すときの本人確認に使う
const author = (() => {
  try {
    let a = localStorage.getItem('oekaki:author');
    if (!a) localStorage.setItem('oekaki:author', a = hex(crypto.getRandomValues(new Uint8Array(16))));
    return a;
  } catch {
    return hex(crypto.getRandomValues(new Uint8Array(16)));
  }
})();

let statusTimer;
function setStatus(text, sticky = false) {
  $('status').textContent = text;
  clearTimeout(statusTimer);
  if (text && !sticky) statusTimer = setTimeout(() => { $('status').textContent = ''; }, 4000);
}

function fatal(message) {
  $('fatalMessage').textContent = message;
  $('fatal').hidden = false;
  document.body.classList.add('is-fatal');
}

// ---- キャンバス ----

const stage = $('stage');
const viewport = $('viewport');
stage.style.width = `${W}px`;
stage.style.height = `${H}px`;

function makeCanvas() {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  return c;
}
const scratch = makeCanvas();                   // renderStroke の作業用
const backup = makeCanvas();                    // 描画中レイヤーの「描き始める前」の状態
const backupCtx = backup.getContext('2d');
const liveCanvas = makeCanvas();                // 他の人が描いている途中の線
const liveCtx = liveCanvas.getContext('2d');
liveCanvas.className = 'live';
stage.append(liveCanvas);

// ---- 状態 ----

let room = null;        // { id, slug, name, visibility, secret }
let ch = null;
let ready = false;
const pending = [];
const whenReady = (fn) => (ready ? fn() : pending.push(fn));

const layerData = new Map();  // レイヤー id → { base: 焼き込み済み画像, strokes: その後の線 }
const views = new Map();      // レイヤー id → { id, name, canvas, ctx, visible, opacity }
let order = [];               // 下から順のレイヤー id
let activeLayer = null;
const knownSids = new Set();  // 反映済み・取り消し済みの線（重複防止）
const live = new Map();       // sid → { s, at }
let liveDirty = false;
let lastStrokeId = 0;
const undoStack = [];
const redoStack = [];

let cur = null;   // 自分が描いている線
let sent = 0;     // cur のうち配信済みの要素数
let smooth = null;

function dataOf(id) {
  let d = layerData.get(id);
  if (!d) layerData.set(id, d = { base: null, strokes: [] });
  return d;
}

// 自分が描いている最中のレイヤーには、backup の方に描き足す（毎フレーム backup + cur で描き直すため）
function drawTarget(id) {
  if (cur?.layer === id) return backupCtx;
  return views.get(id)?.ctx ?? null;
}

function redrawLayer(id) {
  const ctx = drawTarget(id);
  if (!ctx) return;
  const d = dataOf(id);
  ctx.clearRect(0, 0, W, H);
  if (d.base) ctx.drawImage(d.base, 0, 0);
  for (const s of d.strokes) renderStroke(ctx, scratch, s);
  if (ctx === backupCtx) requestFrame();
}

function drawOnLayer(s) {
  const ctx = drawTarget(s.layer);
  if (!ctx) return;
  renderStroke(ctx, scratch, s);
  if (ctx === backupCtx) requestFrame();
}

function applyStroke(s) {
  if (s.id > lastStrokeId) lastStrokeId = s.id;
  if (knownSids.has(s.sid) || !isStroke(s)) return;
  knownSids.add(s.sid);
  if (live.delete(s.sid)) { liveDirty = true; requestFrame(); }
  dataOf(s.layer).strokes.push(s);
  drawOnLayer(s);
}

function findStroke(sid) {
  for (const d of layerData.values()) {
    const s = d.strokes.find((x) => x.sid === sid);
    if (s) return s;
  }
  return null;
}

function removeStroke(sid) {
  for (const [id, d] of layerData) {
    const i = d.strokes.findIndex((x) => x.sid === sid);
    if (i < 0) continue;
    const [s] = d.strokes.splice(i, 1);
    redrawLayer(id);
    return s;
  }
  return null;
}

// ---- フレーム描画 ----

let frameQueued = false;
function requestFrame() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(frame);
}

function frame() {
  frameQueued = false;
  if (cur) {
    const v = views.get(cur.layer);
    v.ctx.clearRect(0, 0, W, H);
    v.ctx.drawImage(backup, 0, 0);
    renderStroke(v.ctx, scratch, cur);
  }
  if (liveDirty) {
    liveDirty = false;
    liveCtx.clearRect(0, 0, W, H);
    for (const { s } of live.values()) {
      if (!s.points.length || views.get(s.layer)?.visible === false) continue;
      // 他人の消しゴムは下のレイヤーを消せないので、白い半透明の線で見せる
      renderStroke(liveCtx, scratch, s.tool === 'eraser' ? { ...s, tool: 'pen', color: '#ffffff', alpha: 70 } : s);
    }
  }
}

// ---- レイヤー ----

function applyLayerStyle(v) {
  v.canvas.style.opacity = v.opacity / 100;
  v.canvas.style.visibility = v.visible ? 'visible' : 'hidden';
}

function setLayers(list) {
  if (!Array.isArray(list) || !list.length) return;
  if (!list.every((l) => typeof l?.id === 'string' && typeof l.name === 'string')) return;
  const ids = list.map((l) => l.id);
  for (const [id, v] of views) {
    if (ids.includes(id)) continue;
    if (cur?.layer === id) cancelStroke();
    v.canvas.remove();
    views.delete(id);
  }
  for (const l of list) {
    let v = views.get(l.id);
    if (!v) {
      const canvas = makeCanvas();
      v = { id: l.id, canvas, ctx: canvas.getContext('2d'), visible: true, opacity: 100 };
      views.set(l.id, v);
      redrawLayer(l.id);
    }
    v.name = l.name;
  }
  order = ids;
  for (const id of order) stage.insertBefore(views.get(id).canvas, liveCanvas);
  if (!views.has(activeLayer)) activeLayer = order.at(-1);
  renderLayerList();
}

function renderLayerList() {
  const items = [...order].reverse().map((id) => {
    const v = views.get(id);
    const li = document.createElement('li');
    li.className = `layer${id === activeLayer ? ' active' : ''}${v.visible ? '' : ' hidden-layer'}`;
    const eye = document.createElement('button');
    eye.className = 'eye';
    eye.textContent = v.visible ? '👁' : '－';
    eye.title = '表示 / 非表示';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      v.visible = !v.visible;
      applyLayerStyle(v);
      liveDirty = true;
      requestFrame();
      renderLayerList();
    });
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = v.name;
    const opacity = document.createElement('input');
    opacity.type = 'range';
    opacity.min = 0;
    opacity.max = 100;
    opacity.value = v.opacity;
    opacity.title = `不透明度 ${v.opacity}%`;
    opacity.addEventListener('input', () => {
      v.opacity = Number(opacity.value);
      opacity.title = `不透明度 ${v.opacity}%`;
      applyLayerStyle(v);
    });
    li.addEventListener('click', () => { activeLayer = id; renderLayerList(); });
    li.addEventListener('dblclick', () => renameLayer(id));
    li.append(eye, name, opacity);
    return li;
  });
  $('layerList').replaceChildren(...items);
  $('layerCount').textContent = `${order.length} / ${MAX_LAYERS}`;
}

const LAYER_ERRORS = {
  too_many_layers: `レイヤーは ${MAX_LAYERS} 枚までです`,
  last_layer: '最後のレイヤーは削除できません',
  bad_name: 'レイヤー名は 1〜20 文字にしてください',
};

async function layerOp(op, layer, name = null) {
  try {
    const list = await rpc('oekaki_layer_op', { p_room: room.id, p_secret: room.secret, p_op: op, p_layer: layer, p_name: name });
    setLayers(list);
    send('layers', list);
    return list;
  } catch (err) {
    console.error(err);
    setStatus(LAYER_ERRORS[err.code] ?? 'レイヤーを変更できませんでした');
    return null;
  }
}

function renameLayer(id) {
  const v = views.get(id);
  const name = prompt('レイヤー名', v.name)?.trim();
  if (name && name !== v.name) layerOp('rename', id, name.slice(0, 20));
}

$('layerAdd').addEventListener('click', async () => {
  const before = new Set(order);
  const list = await layerOp('add', activeLayer, `レイヤー${order.length + 1}`);
  const added = list?.find((l) => !before.has(l.id));
  if (added) { activeLayer = added.id; renderLayerList(); }
});
$('layerUp').addEventListener('click', () => layerOp('up', activeLayer));
$('layerDown').addEventListener('click', () => layerOp('down', activeLayer));
$('layerRename').addEventListener('click', () => renameLayer(activeLayer));
$('layerDelete').addEventListener('click', () => {
  const v = views.get(activeLayer);
  if (confirm(`「${v.name}」を削除しますか？\n部屋の全員の画面から消えます。`)) layerOp('delete', activeLayer);
});
$('layerClear').addEventListener('click', () => {
  const v = views.get(activeLayer);
  if (!confirm(`「${v.name}」の絵を全部消しますか？（取り消しできます）`)) return;
  redoStack.length = 0;
  commit({ sid: crypto.randomUUID(), layer: activeLayer, tool: 'clear', color: '#000000', size: 1, alpha: 100, points: [] });
});

// ---- 道具と設定 ----

const opts = { tool: 'pen', color: '#000000', sizes: { pen: 6, eraser: 30 }, alpha: 100, pressure: true, smoothing: 3 };
try { Object.assign(opts, JSON.parse(localStorage.getItem('oekaki:opts') ?? '{}'), { tool: 'pen' }); } catch {}
const saveOpts = () => { try { localStorage.setItem('oekaki:opts', JSON.stringify(opts)); } catch {} };

const sizeTool = () => (opts.tool === 'eraser' ? 'eraser' : 'pen');

function setTool(t) {
  opts.tool = t;
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === t);
  viewport.dataset.tool = t;
  syncSize();
}

function setColor(c) {
  opts.color = c;
  $('color').value = c;
  for (const el of document.querySelectorAll('.swatch')) el.classList.toggle('active', el.dataset.color === c);
  if (opts.tool !== 'pen') setTool('pen');
  saveOpts();
}

function setSize(n) {
  opts.sizes[sizeTool()] = clamp(Math.round(n) || 1, 1, 200);
  syncSize();
  saveOpts();
}
function syncSize() {
  $('size').value = $('sizeNum').value = opts.sizes[sizeTool()];
}

for (const c of PALETTE) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.style.background = c;
  b.dataset.color = c;
  b.title = c;
  b.addEventListener('click', () => setColor(c));
  $('palette').append(b);
}
for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
$('color').addEventListener('input', () => setColor($('color').value));
$('size').addEventListener('input', () => setSize(Number($('size').value)));
$('sizeNum').addEventListener('change', () => setSize(Number($('sizeNum').value)));
$('alpha').addEventListener('input', () => {
  opts.alpha = Number($('alpha').value);
  $('alphaLabel').textContent = `${opts.alpha}%`;
  saveOpts();
});
$('pressure').addEventListener('change', () => { opts.pressure = $('pressure').checked; saveOpts(); });
$('smoothing').addEventListener('input', () => {
  opts.smoothing = Number($('smoothing').value);
  $('smoothingLabel').textContent = opts.smoothing;
  saveOpts();
});
$('alpha').value = opts.alpha;
$('alphaLabel').textContent = `${opts.alpha}%`;
$('pressure').checked = opts.pressure;
$('smoothing').value = opts.smoothing;
$('smoothingLabel').textContent = opts.smoothing;
setColor(opts.color);
setTool('pen');

// ボタンにフォーカスが残るとスペースキーで押されてしまうので、フォーカスさせない
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button') && !e.target.closest('dialog, form')) e.preventDefault();
});

// ---- 表示位置（ズーム・パン） ----

const view = { z: 1, x: 0, y: 0 };

function applyView() {
  stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  $('zoomFit').textContent = `${Math.round(view.z * 100)}%`;
}

function fit() {
  const r = viewport.getBoundingClientRect();
  view.z = clamp(Math.min((r.width - 24) / W, (r.height - 24) / H), ZOOM_MIN, ZOOM_MAX);
  view.x = (r.width - W * view.z) / 2;
  view.y = (r.height - H * view.z) / 2;
  applyView();
}

function zoomAt(cx, cy, factor) {
  const z = clamp(view.z * factor, ZOOM_MIN, ZOOM_MAX);
  const k = z / view.z;
  view.x = cx - (cx - view.x) * k;
  view.y = cy - (cy - view.y) * k;
  view.z = z;
  applyView();
}
function zoomCenter(factor) {
  const r = viewport.getBoundingClientRect();
  zoomAt(r.width / 2, r.height / 2, factor);
}

$('zoomIn').addEventListener('click', () => zoomCenter(1.25));
$('zoomOut').addEventListener('click', () => zoomCenter(0.8));
$('zoomFit').addEventListener('click', fit);

viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = viewport.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) {
    // トラックパッドのピンチも ctrlKey 付きで届く
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-clamp(e.deltaY, -60, 60) * 0.006));
  } else {
    view.x -= e.deltaX;
    view.y -= e.deltaY;
    applyView();
  }
}, { passive: false });

// ---- 自分の描画 ----

function pos(e) {
  const r = stage.getBoundingClientRect();
  return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height];
}

// 手ぶれ補正をかけた座標と筆圧
function strokePoint(e) {
  const [x, y] = pos(e).map((v, i) => clamp(v, -100, (i ? H : W) + 100));
  const p = opts.pressure && e.pointerType === 'pen' ? clamp(Math.round(e.pressure * 100), 1, 100) : 100;
  if (!smooth) {
    smooth = { x, y };
  } else {
    const k = 1 / (1 + opts.smoothing);
    smooth.x += (x - smooth.x) * k;
    smooth.y += (y - smooth.y) * k;
  }
  return [Math.round(smooth.x * 10) / 10, Math.round(smooth.y * 10) / 10, p];
}

function startStroke(e) {
  const v = views.get(activeLayer);
  if (!v) return;
  if (!v.visible) { setStatus('非表示のレイヤーには描けません'); return; }
  backupCtx.clearRect(0, 0, W, H);
  backupCtx.drawImage(v.canvas, 0, 0);
  smooth = null;
  cur = {
    sid: crypto.randomUUID(), layer: activeLayer, tool: opts.tool, color: opts.color,
    size: opts.sizes[sizeTool()], alpha: opts.alpha, points: strokePoint(e),
  };
  sent = 0;
  requestFrame();
}

function extendStroke(e) {
  const pt = strokePoint(e);
  const p = cur.points;
  const n = p.length;
  if (p[n - 3] === pt[0] && p[n - 2] === pt[1]) {
    p[n - 1] = Math.max(p[n - 1], pt[2]);
    return;
  }
  p.push(...pt);
  requestFrame();
  // 長すぎる線は区切って、続きを新しい線にする
  if (p.length >= MAX_POINTS) {
    endStroke();
    startStroke(e);
  }
}

function endStroke() {
  if (!cur) return;
  const s = cur;
  flushLive();
  cur = null;
  const v = views.get(s.layer);
  v.ctx.clearRect(0, 0, W, H);
  v.ctx.drawImage(backup, 0, 0);
  renderStroke(v.ctx, scratch, s);
  redoStack.length = 0;
  commit(s, true);
}

function cancelStroke() {
  if (!cur) return;
  const v = views.get(cur.layer);
  if (v) {
    v.ctx.clearRect(0, 0, W, H);
    v.ctx.drawImage(backup, 0, 0);
  }
  if (sent) send('cancel', { sid: cur.sid });
  cur = null;
}

// 描いている途中の線を他の人へ流す（DB には書かない）
function flushLive() {
  if (!cur || cur.points.length <= sent) return;
  const { sid, layer, tool, color, size, alpha } = cur;
  send('live', { sid, layer, tool, color, size, alpha, points: cur.points.slice(sent) });
  sent = cur.points.length;
}
setInterval(flushLive, LIVE_INTERVAL);

async function commit(s, rendered = false) {
  knownSids.add(s.sid);
  dataOf(s.layer).strokes.push(s);
  if (!rendered) drawOnLayer(s);
  undoStack.push(s.sid);
  if (undoStack.length > 200) undoStack.shift();
  try {
    s.id = await rpc('oekaki_add_stroke', { p_room: room.id, p_secret: room.secret, p_stroke: s, p_author: author });
    send('stroke', s);
  } catch (err) {
    console.error(err);
    removeStroke(s.sid);
    const i = undoStack.lastIndexOf(s.sid);
    if (i >= 0) undoStack.splice(i, 1);
    send('cancel', { sid: s.sid });
    setStatus('線を保存できませんでした');
  }
}

let undoBusy = false;
async function undo() {
  if (undoBusy || cur) return;
  const sid = undoStack.at(-1);
  if (!sid) return;
  const s = findStroke(sid);
  if (!s) { undoStack.pop(); return; }
  if (!s.id) return;  // まだ保存中
  undoBusy = true;
  try {
    const ok = await rpc('oekaki_undo_stroke', { p_room: room.id, p_secret: room.secret, p_sid: sid, p_author: author });
    if (!ok) {
      undoStack.length = 0;
      setStatus('30分以上前の線は取り消せません');
      return;
    }
    undoStack.pop();
    removeStroke(sid);
    send('undo', { sid });
    const { id, ...rest } = s;
    redoStack.push(rest);
  } catch (err) {
    console.error(err);
    setStatus('取り消せませんでした');
  } finally {
    undoBusy = false;
  }
}

function redo() {
  const s = redoStack.pop();
  if (!s || cur) return;
  if (!views.has(s.layer)) { setStatus('そのレイヤーは削除されています'); return; }
  commit({ ...s, sid: crypto.randomUUID() });
}

$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);

// ---- スポイト・書き出し ----

const pickCanvas = document.createElement('canvas');
pickCanvas.width = pickCanvas.height = 1;
const pickCtx = pickCanvas.getContext('2d', { willReadFrequently: true });

function pickColor(e) {
  const [x, y] = pos(e).map(Math.floor);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  pickCtx.globalAlpha = 1;
  pickCtx.fillStyle = '#ffffff';
  pickCtx.fillRect(0, 0, 1, 1);
  for (const id of order) {
    const v = views.get(id);
    if (!v.visible) continue;
    pickCtx.globalAlpha = v.opacity / 100;
    pickCtx.drawImage(v.canvas, x, y, 1, 1, 0, 0, 1, 1);
  }
  const [r, g, b] = pickCtx.getImageData(0, 0, 1, 1).data;
  setColor(`#${hex([r, g, b])}`);
}

$('download').addEventListener('click', () => {
  const c = makeCanvas();
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  for (const id of order) {
    const v = views.get(id);
    if (!v.visible) continue;
    ctx.globalAlpha = v.opacity / 100;
    ctx.drawImage(v.canvas, 0, 0);
  }
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = `${room?.name ?? 'oekaki'}-${Date.now()}.png`;
  a.click();
});

// ---- ポインター操作 ----

const touches = new Map();
let pinch = null;
let pan = null;
let spaceDown = false;
const brushCursor = $('brushCursor');

function touchPair() {
  const [a, b] = [...touches.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}
function startPinch() {
  const t = touchPair();
  const r = viewport.getBoundingClientRect();
  pinch = { ...t, r, z: view.z, cx: (t.mx - r.left - view.x) / view.z, cy: (t.my - r.top - view.y) / view.z };
}
function updatePinch() {
  const t = touchPair();
  view.z = clamp(pinch.z * t.d / pinch.d, ZOOM_MIN, ZOOM_MAX);
  view.x = t.mx - pinch.r.left - pinch.cx * view.z;
  view.y = t.my - pinch.r.top - pinch.cy * view.z;
  applyView();
}

function moveBrushCursor(e) {
  const show = (opts.tool === 'pen' || opts.tool === 'eraser') && !pan && !pinch && !spaceDown && e.pointerType !== 'touch';
  brushCursor.hidden = !show;
  if (!show) return;
  const r = viewport.getBoundingClientRect();
  const d = Math.max(4, opts.sizes[sizeTool()] * view.z);
  brushCursor.style.width = brushCursor.style.height = `${d}px`;
  brushCursor.style.transform = `translate(${e.clientX - r.left - d / 2}px, ${e.clientY - r.top - d / 2}px)`;
}

viewport.addEventListener('pointerdown', (e) => {
  // すでに離れたポインターだと例外になるので無視する
  try { viewport.setPointerCapture(e.pointerId); } catch {}
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // 2 本指になったら描きかけの線をやめてピンチ操作にする
    if (touches.size === 2) { cancelStroke(); pan = null; startPinch(); return; }
    if (touches.size > 2) return;
  }
  if (e.button === 1 || spaceDown || opts.tool === 'hand') {
    e.preventDefault();
    pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    viewport.classList.add('panning');
    return;
  }
  if (e.button !== 0 || !ready) return;
  if (opts.tool === 'eyedropper' || e.altKey) {
    pickColor(e);
    return;
  }
  startStroke(e);
});

viewport.addEventListener('pointermove', (e) => {
  moveBrushCursor(e);
  if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch) { updatePinch(); return; }
  if (pan) {
    view.x = pan.vx + e.clientX - pan.x;
    view.y = pan.vy + e.clientY - pan.y;
    applyView();
    return;
  }
  if (!cur) return;
  // 環境によっては空配列が返るので、そのときは元のイベントを使う
  const evs = e.getCoalescedEvents?.() ?? [];
  for (const ev of evs.length ? evs : [e]) {
    if (!cur) break;
    extendStroke(ev);
  }
});

function pointerEnd(e) {
  touches.delete(e.pointerId);
  if (pinch) {
    if (touches.size < 2) pinch = null;
    return;
  }
  if (pan) {
    pan = null;
    viewport.classList.remove('panning');
    return;
  }
  endStroke();
}
viewport.addEventListener('pointerup', pointerEnd);
viewport.addEventListener('pointercancel', pointerEnd);
viewport.addEventListener('pointerleave', () => { brushCursor.hidden = true; });
viewport.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- キーボード ----

document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, dialog')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod || e.altKey) return;
  if (e.key === ' ') {
    e.preventDefault();
    if (!spaceDown) { spaceDown = true; viewport.classList.add('space'); brushCursor.hidden = true; }
    return;
  }
  const step = () => Math.max(1, Math.round(opts.sizes[sizeTool()] * 0.15));
  const actions = {
    b: () => setTool('pen'),
    e: () => setTool('eraser'),
    i: () => setTool('eyedropper'),
    h: () => setTool('hand'),
    '[': () => setSize(opts.sizes[sizeTool()] - step()),
    ']': () => setSize(opts.sizes[sizeTool()] + step()),
    0: fit,
    '+': () => zoomCenter(1.25),
    ';': () => zoomCenter(1.25),
    '-': () => zoomCenter(0.8),
  };
  const fn = actions[k];
  if (fn) { e.preventDefault(); fn(); }
});
document.addEventListener('keyup', (e) => {
  if (e.key !== ' ') return;
  spaceDown = false;
  viewport.classList.remove('space');
  if (!e.target.closest?.('input, textarea')) e.preventDefault();
});

// ---- チャット ----

const list = $('messages');
const seenMessages = new Set();

function addMessage(m) {
  if (typeof m?.id !== 'number' || typeof m.name !== 'string' || typeof m.body !== 'string') return;
  if (seenMessages.has(m.id)) return;
  seenMessages.add(m.id);
  const li = document.createElement('li');
  const name = document.createElement('b');
  name.textContent = m.name;
  const time = document.createElement('time');
  time.textContent = new Date(m.created_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  li.append(name, time, document.createElement('br'), m.body);
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.append(li);
  if (atBottom) list.scrollTop = list.scrollHeight;
}

const nameInput = $('name');
try { nameInput.value = localStorage.getItem('oekaki:name') ?? ''; } catch {}

$('chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const body = $('body').value.trim();
  if (!name || !body || !ready) return;
  try { localStorage.setItem('oekaki:name', name); } catch {}
  $('body').value = '';
  try {
    const m = await rpc('oekaki_add_message', { p_room: room.id, p_secret: room.secret, p_name: name, p_body: body });
    addMessage(m);
    send('msg', m);
  } catch (err) {
    console.error(err);
    setStatus('メッセージを送れませんでした');
  }
});

// ---- 画面まわり ----

$('copyLink').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(`${location.origin}${location.pathname}?r=${encodeURIComponent(slug)}`);
    setStatus(room?.visibility === 'password' ? 'URL をコピーしました（パスワードは別に伝えてください）' : 'URL をコピーしました');
  } catch {
    setStatus('コピーできませんでした');
  }
});
$('togglePanel').addEventListener('click', () => document.body.classList.toggle('panel-open'));

// ---- 通信 ----

function send(event, payload) {
  ch?.send({ type: 'broadcast', event, payload });
}

function onLive(p) {
  if (!p || knownSids.has(p.sid) || !Array.isArray(p.points) || p.points.length % 3 || !p.points.every(Number.isFinite)) return;
  let e = live.get(p.sid);
  if (!e) {
    const s = { sid: p.sid, layer: p.layer, tool: p.tool, color: p.color, size: p.size, alpha: p.alpha, points: [] };
    if (!isStroke({ ...s, points: [0, 0, 100] })) return;
    live.set(p.sid, e = { s, at: 0 });
  }
  if (e.s.points.length + p.points.length > MAX_POINTS) return;
  e.s.points.push(...p.points);
  e.at = Date.now();
  liveDirty = true;
  requestFrame();
}

// 途中で接続が切れた人の描きかけの線を片付ける
setInterval(() => {
  const now = Date.now();
  for (const [sid, e] of live) {
    if (now - e.at > 10000) { live.delete(sid); liveDirty = true; }
  }
  if (liveDirty) requestFrame();
}, 3000);

// 部屋の secret を知っている人だけが同じチャンネル名にたどり着ける
async function channelName(secret) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`channel:${secret}`));
  return `oekaki-${hex(new Uint8Array(d)).slice(0, 32)}`;
}

async function connect() {
  ch = sb.channel(await channelName(room.secret), {
    config: { broadcast: { self: false }, presence: { key: crypto.randomUUID() } },
  });
  ch.on('broadcast', { event: 'live' }, ({ payload }) => whenReady(() => onLive(payload)))
    .on('broadcast', { event: 'stroke' }, ({ payload }) => whenReady(() => {
      if (typeof payload?.id === 'number') applyStroke(payload);
    }))
    .on('broadcast', { event: 'cancel' }, ({ payload }) => {
      if (live.delete(payload?.sid)) { liveDirty = true; requestFrame(); }
    })
    .on('broadcast', { event: 'undo' }, ({ payload }) => whenReady(() => {
      if (typeof payload?.sid !== 'string') return;
      knownSids.add(payload.sid);
      removeStroke(payload.sid);
    }))
    .on('broadcast', { event: 'layers' }, ({ payload }) => whenReady(() => setLayers(payload)))
    .on('broadcast', { event: 'msg' }, ({ payload }) => whenReady(() => addMessage(payload)))
    .on('presence', { event: 'sync' }, () => {
      $('online').textContent = `👥 ${Object.keys(ch.presenceState()).length}人`;
    });

  await new Promise((resolve, reject) => {
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        ch.track({});
        // 再接続したときは途切れていた間の線を取り直す
        if (ready) catchUp().catch(console.error);
        resolve();
      } else if (!ready && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')) {
        reject(new Error(status));
      }
    });
  });
}

// GitHub に置かれたレイヤー画像（アーカイブ済みの線を焼き込んだもの）を下敷きにする。
// 非公開の部屋は secret から作った鍵で暗号化されている。
async function loadArchive() {
  const res = await fetch(`data/${room.id}/meta.json?t=${Date.now()}`).catch(() => null);
  if (!res?.ok) return;
  const meta = await res.json();
  let key = null;
  if (room.visibility !== 'public') {
    const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`archive:${room.secret}`));
    key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  }
  await Promise.all(Object.entries(meta.layers ?? {}).map(async ([id, file]) => {
    try {
      let buf = await (await fetch(`data/${room.id}/${file}`)).arrayBuffer();
      if (key) buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
      dataOf(id).base = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
      redrawLayer(id);
    } catch (err) {
      console.warn('レイヤー画像を読み込めませんでした', id, err);
    }
  }));
  lastStrokeId = meta.lastStrokeId ?? 0;
}

// まだアーカイブされていない線を Supabase から取る
async function catchUp() {
  for (;;) {
    const rows = await rpc('oekaki_fetch_strokes', { p_room: room.id, p_secret: room.secret, p_after: lastStrokeId });
    const before = lastStrokeId;
    rows.forEach(applyStroke);
    if (rows.length < 1000 || lastStrokeId === before) break;
  }
}

async function loadMessages() {
  const rows = await rpc('oekaki_fetch_messages', { p_room: room.id, p_secret: room.secret });
  rows.forEach(addMessage);
}

async function enter(password = null) {
  room = await rpc('oekaki_join', { p_slug: slug, p_password: password, p_secret: savedSecret(slug) });
  saveSecret(slug, room.secret);
}

function askPassword() {
  const dialog = $('passwordDialog');
  dialog.addEventListener('cancel', (e) => e.preventDefault());
  dialog.showModal();
  return new Promise((resolve) => {
    $('passwordForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = e.target.querySelector('button');
      button.disabled = true;
      try {
        await enter($('passwordInput').value);
        dialog.close();
        resolve();
      } catch (err) {
        $('passwordError').textContent = err.code === 'wrong_password' ? 'パスワードが違います' : `入れませんでした（${err.code}）`;
        $('passwordError').hidden = false;
        button.disabled = false;
      }
    });
  });
}

async function start() {
  if (!slug) return fatal('部屋が指定されていません');
  try {
    await enter();
  } catch (err) {
    if (err.code === 'not_found') return fatal('部屋が見つかりません');
    if (err.code !== 'password_required') throw err;
    forgetSecret(slug);
    await askPassword();
  }
  document.title = `${room.name} - 絵チャ`;
  $('roomName').textContent = room.name;
  $('roomBadge').textContent = VISIBILITY_LABEL[room.visibility];
  $('roomBadge').dataset.visibility = room.visibility;
  $('roomBadge').hidden = false;
  setStatus('読み込み中…', true);
  fit();
  setLayers(room.layers);
  await connect();
  await loadArchive().catch((err) => console.warn('アーカイブなし', err));
  await catchUp();
  await loadMessages();
  ready = true;
  pending.splice(0).forEach((fn) => fn());
  setStatus('');
}

start().catch((err) => {
  console.error(err);
  setStatus('接続に失敗しました。再読み込みしてください', true);
});
