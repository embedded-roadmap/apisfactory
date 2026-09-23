-- Oturum 12 (W27/W28): kayda bağlı iç mesajlaşma (bahsetme, okundu) ve toplantı: gündem, katılım, tutanak,
-- karar ve aksiyon; tutanak kapanınca aksiyonlar göreve dönüşür ve tutanak değişmez.

create table threads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  entity_type text not null,
  entity_id uuid not null,
  created_at timestamptz not null default now(),
  unique (company_id, entity_type, entity_id)
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  thread_id uuid not null references threads(id),
  author_id uuid not null references users(id),
  body text not null check (length(body) between 1 and 4000),
  reply_to uuid references messages(id),
  created_at timestamptz not null default now(),
  retracted_at timestamptz,
  retract_reason text
);
create index messages_thread on messages (thread_id, created_at);

-- Mesaj metni değişmez; yalnızca yazarın geri çekmesi (gerekçeli) işaretlenebilir.
create or replace function guard_message_update() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'append_only: mesaj silinemez' using errcode = 'P0001'; end if;
  if new.body <> old.body or new.author_id <> old.author_id or new.thread_id <> old.thread_id or new.created_at <> old.created_at then
    raise exception 'append_only: mesaj metni değiştirilemez' using errcode = 'P0001';
  end if;
  if old.retracted_at is not null then raise exception 'append_only: geri çekilmiş mesaj değiştirilemez' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger messages_guard before update or delete on messages for each row execute function guard_message_update();

create table message_mentions (
  company_id uuid not null references companies(id),
  message_id uuid not null references messages(id),
  user_id uuid not null references users(id),
  read_at timestamptz,
  primary key (message_id, user_id)
);
create index message_mentions_unread on message_mentions (user_id) where read_at is null;

create table thread_reads (
  company_id uuid not null references companies(id),
  thread_id uuid not null references threads(id),
  user_id uuid not null references users(id),
  last_read_at timestamptz not null default now(),
  primary key (thread_id, user_id)
);

create table meetings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  title text not null,
  starts_at timestamptz not null,
  duration_minutes int not null default 60 check (duration_minutes between 5 and 600),
  location text,
  agenda text,
  notes text,
  status text not null default 'planned' check (status in ('planned', 'closed', 'cancelled')),
  entity_type text,
  entity_id uuid,
  organizer_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references users(id),
  cancel_reason text,
  unique (company_id, code),
  check ((entity_type is null) = (entity_id is null))
);

create table meeting_participants (
  company_id uuid not null references companies(id),
  meeting_id uuid not null references meetings(id),
  user_id uuid not null references users(id),
  attendance text not null default 'invited' check (attendance in ('invited', 'attended', 'absent', 'excused')),
  primary key (meeting_id, user_id)
);

create table meeting_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  meeting_id uuid not null references meetings(id),
  seq int not null,
  kind text not null check (kind in ('decision', 'action', 'info')),
  text text not null check (length(text) between 3 and 2000),
  owner_user_id uuid references users(id),
  due_date date,
  task_id uuid references tasks(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (meeting_id, seq),
  check (kind <> 'action' or (owner_user_id is not null and due_date is not null))
);

-- Kapanmış/iptal toplantının tutanağı, katılımı ve kararları değişmez (aksiyon görevleri kapanıştan önce aynı işlemde bağlanır).
create or replace function guard_closed_meeting() returns trigger
language plpgsql as $$
declare st text;
begin
  if tg_table_name = 'meetings' then
    if old.status <> 'planned' then raise exception 'meeting_closed: kapanmış toplantı değiştirilemez' using errcode = 'P0001'; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    select status into st from meetings where id = old.meeting_id;
  else
    select status into st from meetings where id = new.meeting_id;
  end if;
  if st = 'planned' then return coalesce(new, old); end if;
  raise exception 'meeting_closed: kapanmış toplantının tutanağı değiştirilemez' using errcode = 'P0001';
  return coalesce(new, old);
end $$;
create trigger meetings_guard before update on meetings for each row execute function guard_closed_meeting();
create trigger meeting_items_guard before insert or update or delete on meeting_items for each row execute function guard_closed_meeting();
create trigger meeting_participants_guard before insert or update or delete on meeting_participants for each row execute function guard_closed_meeting();

do $$
declare t text;
begin
  foreach t in array array['threads', 'messages', 'message_mentions', 'thread_reads', 'meetings', 'meeting_participants', 'meeting_items'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update on threads, messages, message_mentions, thread_reads, meetings, meeting_participants, meeting_items to apis_app;
grant delete on meeting_participants, meeting_items to apis_app;
