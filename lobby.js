import { rpc, saveSecret } from './lib.js';

const $ = (id) => document.getElementById(id);

// 旧 URL（?room=lobby）からの移動。ほかの旧部屋は無くなったのでロビーのまま
if (new URLSearchParams(location.search).get('room') === 'lobby') location.replace('room.html?r=lobby');

const form = $('createForm');
const passwordInput = $('roomPassword');

form.addEventListener('change', () => {
  const isPassword = form.visibility.value === 'password';
  $('passwordRow').hidden = !isPassword;
  passwordInput.required = isPassword;
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = form.querySelector('button');
  const visibility = form.visibility.value;
  const password = visibility === 'password' ? passwordInput.value : null;
  button.disabled = true;
  $('createError').hidden = true;
  try {
    const slug = await rpc('oekaki_create_room', { p_name: $('roomName').value, p_visibility: visibility, p_password: password });
    // 作った本人はパスワードを聞かれずに入れるようにしておく
    const room = await rpc('oekaki_join', { p_slug: slug, p_password: password });
    saveSecret(slug, room.secret);
    location.href = `room.html?r=${encodeURIComponent(slug)}`;
  } catch (err) {
    $('createError').textContent = `作成できませんでした（${err.code ?? err.message}）`;
    $('createError').hidden = false;
    button.disabled = false;
  }
});

function ago(iso) {
  const min = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  if (min < 1440) return `${Math.floor(min / 60)}時間前`;
  return `${Math.floor(min / 1440)}日前`;
}

async function loadRooms() {
  const list = $('roomList');
  try {
    const rooms = await rpc('oekaki_list_rooms');
    list.replaceChildren(...rooms.map((r) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `room.html?r=${encodeURIComponent(r.slug)}`;
      a.textContent = r.name;
      const time = document.createElement('span');
      time.className = 'muted small';
      time.textContent = ago(r.last_active_at);
      li.append(a, time);
      return li;
    }));
    if (!rooms.length) list.innerHTML = '<li class="muted">まだありません</li>';
  } catch (err) {
    console.error(err);
    list.innerHTML = '<li class="error">読み込めませんでした</li>';
  }
}
loadRooms();
