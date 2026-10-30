// Supabase のデータを GitHub リポジトリ（data/）へ移して DB を軽く保つスクリプト。
//
//   node scripts/archive.mjs           … 線を PNG に焼き込み、古いチャットを JSON に追記する
//   node scripts/archive.mjs --cleanup … push 済みの data/*/meta.json を基準に DB から削除する
//
// 削除は push が成功した後に別ステップで行うので、途中で失敗してもデータは消えない。
import { createCanvas, loadImage } from '@napi-rs/canvas';
import fs from 'node:fs/promises';
import path from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) throw new Error('SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を設定してください');

const W = 1600, H = 1000;                 // app.js と合わせる
const DATA_DIR = 'data';
const STROKE_GRACE_MS = 2 * 3600 * 1000;  // 古い meta.json を読んだ閲覧者のために、焼き込み済みの線もしばらく残す
const MESSAGE_KEEP_MS = 24 * 3600 * 1000; // これより新しいチャットは DB に残す
const ROOM_RE = /^[A-Za-z0-9_-]{1,32}$/;

async function rest(query, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`${res.status} ${query}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function fetchAll(table, select, filter = '') {
  const rows = [];
  let last = 0;
  for (;;) {
    const page = await rest(`${table}?select=${select}&id=gt.${last}${filter}&order=id&limit=1000`);
    rows.push(...page);
    if (page.length < 1000) return rows;
    last = page.at(-1).id;
  }
}

function groupByRoom(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!ROOM_RE.test(r.room)) continue;
    if (!map.has(r.room)) map.set(r.room, []);
    map.get(r.room).push(r);
  }
  return map;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value) + '\n');
}

const readMeta = (room) => readJson(path.join(DATA_DIR, room, 'meta.json'), { lastStrokeId: 0, lastMessageId: 0, snapshot: null });

// app.js の drawStroke と同じ描き方にする
function drawStroke(ctx, { color, size, points }) {
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  if (points.length === 2) ctx.lineTo(points[0] + 0.01, points[1]);
  for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
  ctx.stroke();
}

async function archiveStrokes(room, strokes, meta) {
  const fresh = strokes.filter((s) => s.id > meta.lastStrokeId);
  if (!fresh.length) return;
  const dir = path.join(DATA_DIR, room);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  if (meta.snapshot) ctx.drawImage(await loadImage(path.join(dir, meta.snapshot)), 0, 0, W, H);
  for (const s of fresh) drawStroke(ctx, s);

  const lastId = fresh.at(-1).id;
  const file = `snapshot-${lastId}.png`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, file), canvas.toBuffer('image/png'));

  // 今回と前回のスナップショットだけ残す（過去の絵は git の履歴に残る）
  for (const f of await fs.readdir(dir)) {
    if (/^snapshot-\d+\.png$/.test(f) && f !== file && f !== meta.snapshot) await fs.unlink(path.join(dir, f));
  }
  meta.lastStrokeId = lastId;
  meta.snapshot = file;
  console.log(`[${room}] 線 ${fresh.length} 本を ${file} に焼き込み`);
}

async function archiveMessages(room, messages, meta) {
  const fresh = messages.filter((m) => m.id > meta.lastMessageId);
  if (!fresh.length) return;
  // 日本時間の月ごとに data/<room>/log/YYYY-MM.json へ追記
  const byMonth = new Map();
  for (const m of fresh) {
    const month = new Date(Date.parse(m.created_at) + 9 * 3600 * 1000).toISOString().slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push({ id: m.id, name: m.name, body: m.body, created_at: m.created_at });
  }
  for (const [month, items] of byMonth) {
    const file = path.join(DATA_DIR, room, 'log', `${month}.json`);
    const log = await readJson(file, []);
    await writeJson(file, [...log, ...items]);
  }
  meta.lastMessageId = fresh.at(-1).id;
  console.log(`[${room}] チャット ${fresh.length} 件をログへ移動`);
}

async function archive() {
  const msgCutoff = new Date(Date.now() - MESSAGE_KEEP_MS).toISOString();
  const strokesByRoom = groupByRoom(await fetchAll('oekaki_strokes', 'id,room,color,size,points'));
  const messagesByRoom = groupByRoom(await fetchAll('oekaki_messages', 'id,room,name,body,created_at', `&created_at=lt.${msgCutoff}`));
  const rooms = new Set([...strokesByRoom.keys(), ...messagesByRoom.keys()]);

  for (const room of rooms) {
    const meta = await readMeta(room);
    const before = JSON.stringify(meta);
    await archiveStrokes(room, strokesByRoom.get(room) ?? [], meta);
    await archiveMessages(room, messagesByRoom.get(room) ?? [], meta);
    if (JSON.stringify(meta) !== before) {
      await writeJson(path.join(DATA_DIR, room, 'meta.json'), { ...meta, updatedAt: new Date().toISOString() });
    }
  }
}

async function cleanup() {
  const strokeCutoff = new Date(Date.now() - STROKE_GRACE_MS).toISOString();
  const rooms = (await fs.readdir(DATA_DIR, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && ROOM_RE.test(d.name)).map((d) => d.name);
  for (const room of rooms) {
    const meta = await readMeta(room);
    if (meta.lastStrokeId) {
      await rest(`oekaki_strokes?room=eq.${room}&id=lte.${meta.lastStrokeId}&created_at=lt.${strokeCutoff}`, { method: 'DELETE' });
    }
    if (meta.lastMessageId) {
      await rest(`oekaki_messages?room=eq.${room}&id=lte.${meta.lastMessageId}`, { method: 'DELETE' });
    }
  }
  console.log(`${rooms.length} 部屋ぶんの古いデータを DB から削除`);
}

await (process.argv.includes('--cleanup') ? cleanup() : archive());
