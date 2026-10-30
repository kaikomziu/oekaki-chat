// ブラウザ（room.js）と GitHub Actions（scripts/archive.mjs）で共通の描画処理。
// 両方で同じ絵になるよう、線の描き方はここだけに書く。

export const W = 1600, H = 1000;
// 1 本の線の最大要素数（x, y, 筆圧 で 3 要素。DB の制約と合わせる）
export const MAX_POINTS = 6000;

export function isStroke(s) {
  if (!s || typeof s.sid !== 'string' || typeof s.layer !== 'string') return false;
  if (!['pen', 'eraser', 'clear'].includes(s.tool)) return false;
  if (!/^#[0-9a-fA-F]{6}$/.test(s.color)) return false;
  if (!(s.size >= 1 && s.size <= 200 && s.alpha >= 1 && s.alpha <= 100)) return false;
  if (!Array.isArray(s.points) || s.points.length > MAX_POINTS || s.points.length % 3) return false;
  if ((s.tool === 'clear') !== (s.points.length === 0)) return false;
  return s.points.every(Number.isFinite);
}

// 線が描かれる範囲（キャンバス内に切り詰める）
function bounds(points, size) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < points.length; i += 3) {
    x0 = Math.min(x0, points[i]); x1 = Math.max(x1, points[i]);
    y0 = Math.min(y0, points[i + 1]); y1 = Math.max(y1, points[i + 1]);
  }
  const m = size / 2 + 2;
  x0 = Math.max(0, Math.floor(x0 - m)); y0 = Math.max(0, Math.floor(y0 - m));
  x1 = Math.min(W, Math.ceil(x1 + m)); y1 = Math.min(H, Math.ceil(y1 + m));
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

// 中点をつなぐ二次曲線で滑らかにし、区間ごとに筆圧で太さを変える
function trace(ctx, points, size) {
  const n = points.length / 3;
  const X = (i) => points[i * 3], Y = (i) => points[i * 3 + 1];
  const P = (i) => Math.max(1, points[i * 3 + 2]) / 100;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(X(0), Y(0), Math.max(0.5, size * P(0) / 2), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  let sx = X(0), sy = Y(0);
  for (let i = 1; i < n; i++) {
    const last = i === n - 1;
    const ex = last ? X(i) : (X(i) + X(i + 1)) / 2;
    const ey = last ? Y(i) : (Y(i) + Y(i + 1)) / 2;
    ctx.lineWidth = Math.max(0.5, size * (P(i - 1) + P(i)) / 2);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(X(i), Y(i), ex, ey);
    ctx.stroke();
    sx = ex; sy = ey;
  }
}

// 線をいったん scratch に不透明で描き、それを不透明度つきで重ねる。
// こうすると半透明の線で区間の重なりが濃くならず、消しゴムも同じ仕組みで扱える。
export function renderStroke(ctx, scratch, s) {
  if (s.tool === 'clear') {
    ctx.clearRect(0, 0, W, H);
    return;
  }
  const b = bounds(s.points, s.size);
  if (!b) return;
  const [x, y, w, h] = b;
  const sc = scratch.getContext('2d');
  sc.clearRect(x, y, w, h);
  sc.fillStyle = sc.strokeStyle = s.tool === 'eraser' ? '#000000' : s.color;
  trace(sc, s.points, s.size);
  ctx.save();
  ctx.globalAlpha = s.alpha / 100;
  ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
  ctx.drawImage(scratch, x, y, w, h, x, y, w, h);
  ctx.restore();
  sc.clearRect(x, y, w, h);
}
