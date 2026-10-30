-- 絵チャ用スキーマ。Supabase の SQL Editor でそのまま実行する。

-- 確定したストローク（描き終わった線）。定期的に GitHub へ PNG 化して削除される。
create table public.oekaki_strokes (
  id         bigint generated always as identity primary key,
  room       text        not null check (room ~ '^[A-Za-z0-9_-]{1,32}$'),
  sid        uuid        not null unique,
  color      text        not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  size       smallint    not null check (size between 1 and 64),
  -- [x0, y0, x1, y1, ...] の平坦な整数配列
  points     jsonb       not null check (
               jsonb_typeof(points) = 'array'
               and jsonb_array_length(points) between 2 and 4000
             ),
  created_at timestamptz not null default now()
);
create index oekaki_strokes_room_id_idx on public.oekaki_strokes (room, id);

-- チャット。24 時間より古いものは GitHub の JSON ログへ移されて削除される。
create table public.oekaki_messages (
  id         bigint generated always as identity primary key,
  room       text        not null check (room ~ '^[A-Za-z0-9_-]{1,32}$'),
  name       text        not null check (char_length(name) between 1 and 20),
  body       text        not null check (char_length(body) between 1 and 300),
  created_at timestamptz not null default now()
);
create index oekaki_messages_room_id_idx on public.oekaki_messages (room, id);

-- 匿名ユーザーは読み取りと追加だけ。削除はアーカイブ用の service_role のみ。
alter table public.oekaki_strokes  enable row level security;
alter table public.oekaki_messages enable row level security;

create policy "oekaki anon read strokes"    on public.oekaki_strokes  for select to anon using (true);
create policy "oekaki anon insert strokes"  on public.oekaki_strokes  for insert to anon with check (true);
create policy "oekaki anon read messages"   on public.oekaki_messages for select to anon using (true);
create policy "oekaki anon insert messages" on public.oekaki_messages for insert to anon with check (true);

-- INSERT をリアルタイム配信する
alter publication supabase_realtime add table public.oekaki_strokes, public.oekaki_messages;
