import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// キャンバスの論理サイズ（scripts/archive.mjs と合わせる）
const W = 1600, H = 1000;
// 1 ストロークの最大要素数（DB の制約と合わせる。x, y で 2 要素）
const MAX_POINTS = 4000;
const PALETTE = ['#000000', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#6d4c41', '#9e9e9e'];

const roomParam = new URLSearchParams(location.search).get('room') ?? '';
const room = /^[A-Za-z0-9_-]{1,32}$/.test(roomParam) ? roomParam : 'lobby';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

const canvas = $('board');
const ctx = canvas.getContext('2d');
canvas.width = W;
canvas.height = H;
ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, W, H);
$('room').textContent = room;

// ---- 描画 ----

function drawStroke({ color, size, points }) {
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  // 1 点だけのときも丸い点が出るように少しずらす
  if (points.length === 2) ctx.lineTo(points[0] + 0.01, points[1]);
  for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
  ctx.stroke();
}

function isStroke(s) {
  return s && typeof s.sid === 'string'
    && /^#[0-9a-fA-F]{6}$/.test(s.color)
    && Number.isFinite(s.size) && s.size >= 1 && s.size <= 64
    && Array.isArray(s.points) && s.points.length >= 2 && s.points.length <= MAX_POINTS
    && s.points.every(Number.isFinite);
}

// 描画済みストロークの sid（ライブ配信・DB 通知・初期読み込みの重複防止）
const drawn = new Set();
let lastStrokeId = 0;

function applyStroke(s) {
  if (s.id > lastStrokeId) lastStrokeId = s.id;
  if (drawn.has(s.sid) || !isStroke(s)) return;
  drawn.add(s.sid);
  drawStroke(s);
}

// 初期読み込みが終わるまでリアルタイムの受信は溜めておく
let ready = false;
const pending = [];
const whenReady = (fn) => (ready ? fn() : pending.push(fn));

// ---- ツール ----

let color = '#000000';
let tool = 'pen';
const sizeInput = $('size');
const colorInput = $('color');

function setTool(t) {
  tool = t;
  $('pen').classList.toggle('active', t === 'pen');
  $('eraser').classList.toggle('active', t === 'eraser');
}
function setColor(c) {
  color = c;
  colorInput.value = c;
  for (const el of document.querySelectorAll('.swatch')) el.classList.toggle('active', el.dataset.color === c);
  setTool('pen');
}
for (const c of PALETTE) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.style.background = c;
  b.dataset.color = c;
  b.addEventListener('click', () => setColor(c));
  $('palette').append(b);
}
setColor(color);
$('pen').addEventListener('click', () => setTool('pen'));
$('eraser').addEventListener('click', () => setTool('eraser'));
colorInput.addEventListener('input', () => setColor(colorInput.value));
sizeInput.addEventListener('input', () => { $('sizeLabel').textContent = sizeInput.value; });
$('download').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `${room}-${Date.now()}.png`;
  a.click();
});

// ---- 自分の描画 ----

const ch = sb.channel(`oekaki:${room}`, {
  config: { broadcast: { self: false }, presence: { key: crypto.randomUUID() } },
});

let cur = null;  // 描画中のストローク
let sent = 0;    // ライブ配信済みの要素数

function startStroke(x, y) {
  cur = {
    sid: crypto.randomUUID(),
    color: tool === 'eraser' ? '#ffffff' : color,
    size: Number(sizeInput.value),
    points: [x, y],
  };
  sent = 0;
  drawn.add(cur.sid);
  drawStroke(cur);
}

function extendStroke(x, y) {
  const p = cur.points;
  const n = p.length;
  if (p[n - 2] === x && p[n - 1] === y) return;
  p.push(x, y);
  drawStroke({ ...cur, points: p.slice(n - 2) });
  // 長すぎる線は分割して続きを新しいストロークにする
  if (p.length >= MAX_POINTS) {
    endStroke();
    startStroke(x, y);
  }
}

// 描いている途中の線を他の人へ流す（DB には書かないので無料枠を消費しにくい）
function flushLive() {
  if (!cur || cur.points.length <= sent) return;
  ch.send({
    type: 'broadcast',
    event: 'draw',
    payload: { sid: cur.sid, color: cur.color, size: cur.size, points: cur.points.slice(Math.max(0, sent - 2)) },
  });
  sent = cur.points.length;
}
setInterval(flushLive, 50);

async function endStroke() {
  if (!cur) return;
  flushLive();
  const s = cur;
  cur = null;
  const { error } = await sb.from('oekaki_strokes').insert({ room, sid: s.sid, color: s.color, size: s.size, points: s.points });
  if (error) {
    console.error(error);
    setStatus('線の保存に失敗しました');
  }
}

function pos(e) {
  const r = canvas.getBoundingClientRect();
  const x = Math.round((e.clientX - r.left) * W / r.width);
  const y = Math.round((e.clientY - r.top) * H / r.height);
  return [Math.max(0, Math.min(W, x)), Math.max(0, Math.min(H, y))];
}

canvas.addEventListener('pointerdown', (e) => {
  if (!ready || e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  startStroke(...pos(e));
});
canvas.addEventListener('pointermove', (e) => {
  if (!cur) return;
  // 環境によっては空配列が返るので、そのときは元のイベントを使う
  const evs = e.getCoalescedEvents?.() ?? [];
  for (const ev of evs.length ? evs : [e]) extendStroke(...pos(ev));
});
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

// ---- チャット ----

const list = $('messages');
const seenMessages = new Set();

function addMessage(m) {
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
  if (!name || !body) return;
  try { localStorage.setItem('oekaki:name', name); } catch {}
  $('body').value = '';
  const { error } = await sb.from('oekaki_messages').insert({ room, name, body });
  if (error) {
    console.error(error);
    setStatus('メッセージの送信に失敗しました');
  }
});

// ---- 読み込み ----

function setStatus(text) { $('status').textContent = text; }

// GitHub に置かれたスナップショット（アーカイブ済みの線を焼き込んだ PNG）を下敷きにする
async function loadSnapshot() {
  const res = await fetch(`data/${room}/meta.json?t=${Date.now()}`);
  if (!res.ok) return 0;
  const meta = await res.json();
  if (meta.snapshot) {
    const img = new Image();
    img.src = `data/${room}/${meta.snapshot}`;
    await img.decode();
    ctx.drawImage(img, 0, 0, W, H);
  }
  return meta.lastStrokeId ?? 0;
}

// まだアーカイブされていない線を Supabase から取る
async function catchUp(fromId) {
  let last = fromId;
  for (;;) {
    const { data, error } = await sb.from('oekaki_strokes')
      .select('id, sid, color, size, points')
      .eq('room', room).gt('id', last).order('id').limit(1000);
    if (error) throw error;
    data.forEach(applyStroke);
    if (data.length < 1000) break;
    last = data.at(-1).id;
  }
}

async function loadMessages() {
  const { data, error } = await sb.from('oekaki_messages')
    .select('id, name, body, created_at')
    .eq('room', room).order('id', { ascending: false }).limit(50);
  if (error) throw error;
  data.reverse().forEach(addMessage);
}

ch.on('broadcast', { event: 'draw' }, ({ payload }) => whenReady(() => {
  if (isStroke(payload) && !drawn.has(payload.sid)) drawStroke(payload);
}))
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'oekaki_strokes', filter: `room=eq.${room}` },
    ({ new: s }) => whenReady(() => applyStroke(s)))
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'oekaki_messages', filter: `room=eq.${room}` },
    ({ new: m }) => whenReady(() => addMessage(m)))
  .on('presence', { event: 'sync' }, () => {
    $('online').textContent = `👥 ${Object.keys(ch.presenceState()).length}人`;
  });

async function init() {
  await new Promise((resolve, reject) => {
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        ch.track({});
        // 再接続したときは途切れていた間の線を取り直す
        if (ready) catchUp(lastStrokeId).catch(console.error);
        resolve();
      } else if (!ready && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')) {
        reject(new Error(status));
      }
    });
  });
  const snapshotId = await loadSnapshot().catch((e) => { console.warn('スナップショットなし', e); return 0; });
  lastStrokeId = snapshotId;
  await catchUp(snapshotId);
  await loadMessages();
  ready = true;
  pending.splice(0).forEach((fn) => fn());
  setStatus('');
}

init().catch((e) => {
  console.error(e);
  setStatus('接続に失敗しました。再読み込みしてください');
});
