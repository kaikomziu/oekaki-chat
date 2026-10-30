// ロビーと部屋で共通の Supabase まわり
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// RPC のエラー（'oekaki: xxx'）から理由だけ取り出す
export function errorCode(error) {
  return error?.message?.match(/oekaki: (\w+)/)?.[1] ?? error?.message ?? 'unknown';
}

export async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw Object.assign(new Error(errorCode(error)), { code: errorCode(error) });
  return data;
}

// 一度入った部屋の secret を覚えておき、パスワードを聞き直さない
const secretKey = (slug) => `oekaki:secret:${slug}`;
export function savedSecret(slug) {
  try { return localStorage.getItem(secretKey(slug)); } catch { return null; }
}
export function saveSecret(slug, secret) {
  try { localStorage.setItem(secretKey(slug), secret); } catch {}
}
export function forgetSecret(slug) {
  try { localStorage.removeItem(secretKey(slug)); } catch {}
}

export const VISIBILITY_LABEL = { public: '完全公開', unlisted: 'URL限定', password: 'パスワード' };
