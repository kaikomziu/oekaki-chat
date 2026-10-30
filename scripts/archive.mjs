// Supabase のデータを GitHub リポジトリ（data/）へ移して DB を軽く保つスクリプト。
//
//   node scripts/archive.mjs           … 古い線をレイヤーごとの PNG に焼き込み、古いチャットを JSON に追記する
//   node scripts/archive.mjs --cleanup … push 済みの data/*/meta.json を基準に DB から削除する
//
// 削除は push と Pages の反映を待ってから別ステップで行うので、途中で失敗してもデータは消えない。
// リポジトリは公開なので、URL限定・パスワード部屋のファイルは部屋の secret から作った鍵で暗号化する。
//
// DB には公開用の anon キーと、アーカイブ専用の合言葉（OEKAKI_ARCHIVE_TOKEN）でアクセスする。
// service_role キーは使わない。
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { W, H, renderStroke, isStroke } from '../render.js';
import { SUPABASE_URL as CONFIG_URL, SUPABASE_ANON_KEY } from '../config.js';

const SUPABASE_URL = process.env.SUPABASE_URL || CONFIG_URL;
const TOKEN = process.env.OEKAKI_ARCHIVE_TOKEN;
if (!TOKEN) throw new Error('OEKAKI_ARCHIVE_TOKEN を設定してください');

const DATA_DIR = 'data';
const BAKE_AFTER_MS = 60 * 60 * 1000;     // 取り消し（30 分以内）ができなくなった線だけ焼き込む
const MESSAGE_KEEP_MS = 24 * 3600 * 1000; // これより新しいチャットは DB に残す
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LAYER_FILE_RE = /^[A-Za-z0-9]{1,16}-\d+\.(png|bin)$/;

async function rpc(name, args = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: TOKEN, ...args }),
  });
  if (!res.ok) throw new Error(`${res.status} ${name}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// 1000 件ずつ id 順に全部取る
async function fetchAll(name, args = {}) {
  const rows = [];
  let last = 0;
  for (;;) {
    const page = await rpc(name, { ...args, p_after: last });
    rows.push(...page);
    if (page.length < 1000) return rows;
    last = page.at(-1).id;
  }
}

function groupBy(rows, key) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r[key])) map.set(r[key], []);
    map.get(r[key]).push(r);
  }
  return map;
}

// ---- 暗号化（room.js の復号と対になる。形式は IV 12 バイト + 暗号文 + タグ 16 バイト） ----

const archiveKey = (secret) => createHash('sha256').update(`archive:${secret}`).digest();

function encrypt(buf, key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([iv, c.update(buf), c.final(), c.getAuthTag()]);
}

function decrypt(buf, key) {
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
}

async function readFile(file, key) {
  const buf = await fs.readFile(file);
  return key ? decrypt(buf, key) : buf;
}

async function writeFile(file, buf, key) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, key ? encrypt(buf, key) : buf);
}

const readMeta = async (dir) => {
  try { return JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')); }
  catch { return { lastStrokeId: 0, lastMessageId: 0, layers: {} }; }
};

// ---- 線 ----

async function archiveStrokes(room, strokes, meta, key) {
  const dir = path.join(DATA_DIR, room.id);
  const cutoff = Date.now() - BAKE_AFTER_MS;
  // 焼き込むのは「1 時間以上前の最後の線」までのすべて（id 順で区切る）
  const upto = strokes.reduce((m, s) => (Date.parse(s.created_at) < cutoff ? Math.max(m, s.id) : m), 0);
  const bake = strokes.filter((s) => s.id > meta.lastStrokeId && s.id <= upto);
  if (!bake.length) return;

  const alive = new Set(room.layers.map((l) => l.id));
  const scratch = createCanvas(W, H);
  for (const [layerId, list] of groupBy(bake, 'layer')) {
    if (!alive.has(layerId)) continue;  // 削除されたレイヤーは捨てる
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    if (meta.layers[layerId]) {
      ctx.drawImage(await loadImage(await readFile(path.join(dir, meta.layers[layerId]), key)), 0, 0, W, H);
    }
    for (const s of list) if (isStroke(s)) renderStroke(ctx, scratch, s);
    const file = `${layerId}-${upto}.${key ? 'bin' : 'png'}`;
    await writeFile(path.join(dir, file), canvas.toBuffer('image/png'), key);
    meta.layers[layerId] = file;
  }
  for (const id of Object.keys(meta.layers)) if (!alive.has(id)) delete meta.layers[id];
  meta.lastStrokeId = upto;
  console.log(`[${room.id}] 線 ${bake.length} 本を焼き込み`);
}

// 今回と前回の meta に載っているファイルだけ残す（古い meta を読んだ閲覧者のため。過去の絵は git の履歴に残る）
async function pruneFiles(dir, prevLayers, meta) {
  const keep = new Set([...Object.values(prevLayers), ...Object.values(meta.layers)]);
  for (const f of await fs.readdir(dir).catch(() => [])) {
    if (LAYER_FILE_RE.test(f) && !keep.has(f)) await fs.unlink(path.join(dir, f));
  }
}

// ---- チャット ----

async function archiveMessages(room, messages, meta, key) {
  const fresh = messages.filter((m) => m.id > meta.lastMessageId);
  if (!fresh.length) return;
  // 日本時間の月ごとに data/<部屋>/log/YYYY-MM.json（非公開部屋は .bin）へ追記
  const byMonth = groupBy(fresh.map((m) => ({
    month: new Date(Date.parse(m.created_at) + 9 * 3600 * 1000).toISOString().slice(0, 7),
    id: m.id, name: m.name, body: m.body, created_at: m.created_at,
  })), 'month');
  for (const [month, items] of byMonth) {
    const file = path.join(DATA_DIR, room.id, 'log', `${month}.${key ? 'bin' : 'json'}`);
    let log = [];
    try { log = JSON.parse((await readFile(file, key)).toString('utf8')); } catch {}
    log.push(...items.map(({ month: _, ...m }) => m));
    await writeFile(file, Buffer.from(JSON.stringify(log) + '\n'), key);
  }
  meta.lastMessageId = fresh.at(-1).id;
  console.log(`[${room.id}] チャット ${fresh.length} 件をログへ移動`);
}

async function archive() {
  const msgCutoff = new Date(Date.now() - MESSAGE_KEEP_MS).toISOString();
  const rooms = await rpc('oekaki_archive_rooms');
  const strokesByRoom = groupBy(await fetchAll('oekaki_archive_strokes'), 'room_id');
  const messagesByRoom = groupBy(await fetchAll('oekaki_archive_messages', { p_before: msgCutoff }), 'room_id');

  for (const room of rooms) {
    if (!UUID_RE.test(room.id)) continue;
    const strokes = strokesByRoom.get(room.id) ?? [];
    const messages = messagesByRoom.get(room.id) ?? [];
    if (!strokes.length && !messages.length) continue;
    const dir = path.join(DATA_DIR, room.id);
    const key = room.visibility === 'public' ? null : archiveKey(room.secret);
    const meta = await readMeta(dir);
    const before = JSON.stringify(meta);
    const prevLayers = { ...meta.layers };
    await archiveStrokes(room, strokes, meta, key);
    await archiveMessages(room, messages, meta, key);
    if (JSON.stringify(meta) === before) continue;
    await pruneFiles(dir, prevLayers, meta);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, updatedAt: new Date().toISOString() }) + '\n');
  }
}

async function cleanup() {
  const dirs = (await fs.readdir(DATA_DIR, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && UUID_RE.test(d.name)).map((d) => d.name);
  for (const id of dirs) {
    const meta = await readMeta(path.join(DATA_DIR, id));
    if (!meta.lastStrokeId && !meta.lastMessageId) continue;
    await rpc('oekaki_archive_delete', { p_room: id, p_stroke_upto: meta.lastStrokeId ?? 0, p_message_upto: meta.lastMessageId ?? 0 });
  }
  console.log(`${dirs.length} 部屋ぶんの古いデータを DB から削除`);
}

await (process.argv.includes('--cleanup') ? cleanup() : archive());
