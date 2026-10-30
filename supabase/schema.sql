-- 絵チャ用スキーマ。Supabase の SQL Editor でそのまま実行する（pgcrypto は extensions スキーマにある前提）。
--
-- テーブルは匿名ユーザーから直接読み書きできない。すべて部屋の secret を要求する RPC を通す。
-- secret は oekaki_join（公開・URL限定はそのまま、パスワード部屋は照合後）でだけ渡す。

drop table if exists public.oekaki_strokes;
drop table if exists public.oekaki_messages;

create table public.oekaki_rooms (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique check (slug ~ '^[A-Za-z0-9_-]{4,32}$'),
  name           text not null check (char_length(name) between 1 and 40),
  -- public: 一覧に出る / unlisted: URL を知っている人だけ / password: パスワードが必要
  visibility     text not null check (visibility in ('public', 'unlisted', 'password')),
  password_hash  text,
  secret         text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  -- 下から順のレイヤー一覧 [{id, name}]
  layers         jsonb not null default '[{"id": "base", "name": "レイヤー1"}]',
  created_at     timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  check ((visibility = 'password') = (password_hash is not null))
);
create index oekaki_rooms_public_idx on public.oekaki_rooms (last_active_at desc) where visibility = 'public';

-- 確定した線。1 時間以上前のものは毎日 GitHub へ PNG 化されて削除される。
create table public.oekaki_strokes (
  id          bigint generated always as identity primary key,
  room_id     uuid not null references public.oekaki_rooms (id) on delete cascade,
  sid         uuid not null unique,
  layer       text not null check (layer ~ '^[A-Za-z0-9]{1,16}$'),
  -- clear はレイヤー全消し（points は空）
  tool        text not null check (tool in ('pen', 'eraser', 'clear')),
  color       text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  size        smallint not null check (size between 1 and 200),
  alpha       smallint not null check (alpha between 1 and 100),
  -- [x0, y0, 筆圧0, x1, y1, 筆圧1, ...]（筆圧は 1〜100）
  points      jsonb not null check (
                jsonb_typeof(points) = 'array'
                and jsonb_array_length(points) <= 6000
                and jsonb_array_length(points) % 3 = 0
                and not jsonb_path_exists(points, '$[*] ? (@.type() != "number")')
              ),
  author_hash text not null,
  created_at  timestamptz not null default now(),
  check ((tool = 'clear') = (jsonb_array_length(points) = 0))
);
create index oekaki_strokes_room_id_idx on public.oekaki_strokes (room_id, id);

-- チャット。24 時間より古いものは GitHub の JSON ログへ移されて削除される。
create table public.oekaki_messages (
  id         bigint generated always as identity primary key,
  room_id    uuid not null references public.oekaki_rooms (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 20),
  body       text not null check (char_length(body) between 1 and 300),
  created_at timestamptz not null default now()
);
create index oekaki_messages_room_id_idx on public.oekaki_messages (room_id, id);

alter table public.oekaki_rooms    enable row level security;
alter table public.oekaki_strokes  enable row level security;
alter table public.oekaki_messages enable row level security;
revoke all on public.oekaki_rooms, public.oekaki_strokes, public.oekaki_messages from anon, authenticated;

insert into public.oekaki_rooms (slug, name, visibility) values ('lobby', 'ロビー', 'public');

-- ---- 内部用 ----

create function public.oekaki_room_check(p_room uuid, p_secret text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from oekaki_rooms where id = p_room and secret = p_secret) then
    raise exception 'oekaki: forbidden' using errcode = '42501';
  end if;
end $$;
revoke all on function public.oekaki_room_check(uuid, text) from public, anon, authenticated;

-- ---- 部屋 ----

create function public.oekaki_create_room(p_name text, p_visibility text, p_password text default null)
returns text language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_slug text;
begin
  if p_visibility = 'password' and (p_password is null or char_length(p_password) not between 4 and 72) then
    raise exception 'oekaki: bad_password';
  end if;
  -- 公開部屋は短く、それ以外は推測できない長さにする
  v_slug := translate(encode(gen_random_bytes(case when p_visibility = 'public' then 6 else 12 end), 'base64'), '+/=', '-_');
  insert into oekaki_rooms (slug, name, visibility, password_hash)
  values (v_slug, btrim(p_name), p_visibility,
          case when p_visibility = 'password' then crypt(p_password, gen_salt('bf', 8)) end);
  return v_slug;
end $$;

-- p_secret を渡せば（以前入室したことがあれば）パスワードを省ける
create function public.oekaki_join(p_slug text, p_password text default null, p_secret text default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  r oekaki_rooms;
begin
  select * into r from oekaki_rooms where slug = p_slug;
  if not found then
    raise exception 'oekaki: not_found';
  end if;
  if r.visibility = 'password' and p_secret is distinct from r.secret then
    if p_password is null then
      raise exception 'oekaki: password_required';
    end if;
    if crypt(p_password, r.password_hash) <> r.password_hash then
      raise exception 'oekaki: wrong_password';
    end if;
  end if;
  return jsonb_build_object('id', r.id, 'slug', r.slug, 'name', r.name, 'visibility', r.visibility,
                            'secret', r.secret, 'layers', r.layers);
end $$;

create function public.oekaki_list_rooms()
returns table (slug text, name text, last_active_at timestamptz)
language sql stable security definer set search_path = public as $$
  select slug, name, last_active_at from oekaki_rooms
  where visibility = 'public' order by last_active_at desc limit 100;
$$;

-- ---- 線 ----

create function public.oekaki_fetch_strokes(p_room uuid, p_secret text, p_after bigint)
returns table (id bigint, sid uuid, layer text, tool text, color text, size smallint, alpha smallint, points jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  perform oekaki_room_check(p_room, p_secret);
  return query
    select s.id, s.sid, s.layer, s.tool, s.color, s.size, s.alpha, s.points
    from oekaki_strokes s where s.room_id = p_room and s.id > p_after order by s.id limit 1000;
end $$;

-- p_author は端末ごとの合言葉。ハッシュだけ保存し、取り消しの本人確認に使う
create function public.oekaki_add_stroke(p_room uuid, p_secret text, p_stroke jsonb, p_author text)
returns bigint language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_id bigint;
begin
  perform oekaki_room_check(p_room, p_secret);
  if char_length(p_author) not between 16 and 64 then
    raise exception 'oekaki: bad_author';
  end if;
  insert into oekaki_strokes (room_id, sid, layer, tool, color, size, alpha, points, author_hash)
  values (p_room, (p_stroke->>'sid')::uuid, p_stroke->>'layer', p_stroke->>'tool', p_stroke->>'color',
          (p_stroke->>'size')::smallint, (p_stroke->>'alpha')::smallint, p_stroke->'points',
          encode(digest(p_author, 'sha256'), 'hex'))
  returning id into v_id;
  update oekaki_rooms set last_active_at = now()
  where id = p_room and last_active_at < now() - interval '1 minute';
  return v_id;
end $$;

-- 自分の 30 分以内の線だけ取り消せる（1 時間以上前の線は GitHub に焼き込まれるため）
create function public.oekaki_undo_stroke(p_room uuid, p_secret text, p_sid uuid, p_author text)
returns boolean language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  perform oekaki_room_check(p_room, p_secret);
  delete from oekaki_strokes
  where room_id = p_room and sid = p_sid
    and author_hash = encode(digest(p_author, 'sha256'), 'hex')
    and created_at > now() - interval '30 minutes';
  return found;
end $$;

-- ---- レイヤー ----

-- 1 回の UPDATE で配列を書き換えるので、同時操作でも消えない
create function public.oekaki_layer_op(p_room uuid, p_secret text, p_op text, p_layer text default null, p_name text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_layers jsonb;
  v_len int;
  v_idx int;
  v_to int;
  v_item jsonb;
begin
  perform oekaki_room_check(p_room, p_secret);
  if p_name is not null and char_length(btrim(p_name)) not between 1 and 20 then
    raise exception 'oekaki: bad_name';
  end if;
  select layers into v_layers from oekaki_rooms where id = p_room for update;
  v_len := jsonb_array_length(v_layers);
  select t.i - 1 into v_idx from jsonb_array_elements(v_layers) with ordinality as t(e, i) where t.e->>'id' = p_layer;
  if p_op <> 'add' and v_idx is null then
    raise exception 'oekaki: no_layer';
  end if;

  case p_op
    when 'add' then
      if v_len >= 32 then
        raise exception 'oekaki: too_many_layers';
      end if;
      v_item := jsonb_build_object('id', encode(gen_random_bytes(6), 'hex'), 'name', coalesce(btrim(p_name), 'レイヤー'));
      -- 指定レイヤーの直上（なければ最上位）に入れる
      v_layers := jsonb_insert(v_layers, array[coalesce(v_idx, v_len - 1)::text], v_item, true);
    when 'rename' then
      v_layers := jsonb_set(v_layers, array[v_idx::text, 'name'], to_jsonb(btrim(p_name)));
    when 'up', 'down' then
      v_to := v_idx + case when p_op = 'up' then 1 else -1 end;
      if v_to between 0 and v_len - 1 then
        v_item := v_layers->v_idx;
        v_layers := jsonb_set(jsonb_set(v_layers, array[v_idx::text], v_layers->v_to), array[v_to::text], v_item);
      end if;
    when 'delete' then
      if v_len <= 1 then
        raise exception 'oekaki: last_layer';
      end if;
      v_layers := v_layers - v_idx;
    else
      raise exception 'oekaki: bad_op';
  end case;

  update oekaki_rooms set layers = v_layers where id = p_room;
  return v_layers;
end $$;

-- ---- チャット ----

create function public.oekaki_fetch_messages(p_room uuid, p_secret text)
returns table (id bigint, name text, body text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform oekaki_room_check(p_room, p_secret);
  return query
    select * from (
      select m.id, m.name, m.body, m.created_at from oekaki_messages m
      where m.room_id = p_room order by m.id desc limit 50
    ) t order by t.id;
end $$;

create function public.oekaki_add_message(p_room uuid, p_secret text, p_name text, p_body text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  r oekaki_messages;
begin
  perform oekaki_room_check(p_room, p_secret);
  insert into oekaki_messages (room_id, name, body) values (p_room, btrim(p_name), btrim(p_body)) returning * into r;
  return jsonb_build_object('id', r.id, 'name', r.name, 'body', r.body, 'created_at', r.created_at);
end $$;
