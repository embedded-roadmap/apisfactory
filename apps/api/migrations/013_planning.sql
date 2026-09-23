-- Oturum 7 (W26): planlı görevler (öncelik, tarih, kontrol listesi, bağımlılık, baz plan), Gantt,
-- organizasyon şeması (tarihsel, geçici görevlendirme) ve ekip performans raporu için alanlar (prompt §5, §18, §20).

-- ---------------------------------------------------------------------------
-- Görevler: sistem görevleri (kind ≠ manual) varlık+rol başına tekildir; elle açılan görevler serbesttir.
-- ---------------------------------------------------------------------------
alter table tasks drop constraint tasks_company_id_kind_entity_id_assignee_role_key;
create unique index tasks_system_unique on tasks (company_id, kind, entity_id, assignee_role) where kind <> 'manual';

alter table tasks drop constraint tasks_status_check;
alter table tasks add constraint tasks_status_check check (status in ('open', 'in_progress', 'blocked', 'done', 'cancelled'));

alter table tasks add column description text;
alter table tasks add column priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'critical'));
alter table tasks add column start_date date;
alter table tasks add column due_date date;
alter table tasks add column milestone boolean not null default false;
alter table tasks add column checklist jsonb not null default '[]'::jsonb;
alter table tasks add column department_id uuid references departments(id);
alter table tasks add column baseline_start date;
alter table tasks add column baseline_due date;
alter table tasks add column started_at timestamptz;
-- Engel: nedeni kategorili tutulur; dış kaynaklı gecikme (tedarikçi, müşteri) kişinin performansına yazılmaz.
alter table tasks add column blocked_category text check (blocked_category in ('supplier', 'customer', 'material', 'equipment', 'quality', 'other'));
alter table tasks add column blocked_reason text;
alter table tasks add column external_delay boolean not null default false;
alter table tasks add column cancel_reason text;
alter table tasks add column created_by uuid references users(id);
alter table tasks add column closed_by uuid references users(id);
alter table tasks add check (start_date is null or due_date is null or start_date <= due_date);
create index tasks_dates on tasks (company_id, due_date);

create table task_dependencies (
  company_id uuid not null references companies(id),
  task_id uuid not null references tasks(id),
  depends_on_id uuid not null references tasks(id),
  lag_days int not null default 0 check (lag_days between -365 and 365),
  created_at timestamptz not null default now(),
  primary key (task_id, depends_on_id),
  check (task_id <> depends_on_id)
);

-- ---------------------------------------------------------------------------
-- Organizasyon: departman yöneticisi ve üyelik geçmişi. Şema erişim yetkisi DEĞİLDİR (yetki rollerden gelir).
-- ---------------------------------------------------------------------------
alter table departments add column active boolean not null default true;

create table department_members (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  department_id uuid not null references departments(id),
  user_id uuid not null references users(id),
  is_manager boolean not null default false,
  temporary boolean not null default false,
  valid_from date not null default current_date,
  valid_to date,
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from)
);
create index department_members_active on department_members (company_id, department_id) where valid_to is null;

do $$
declare t text;
begin
  foreach t in array array['task_dependencies', 'department_members'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
    execute format('grant select, insert, update, delete on %I to apis_app', t);
  end loop;
end $$;
grant insert, update, delete on departments to apis_app;

do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into role_permissions (company_id, role_id, permission)
    select c.id, r.id, p.perm
      from roles r
      join (values
        ('manager', 'task.manage'), ('production', 'task.manage'), ('rd', 'task.manage'), ('quality', 'task.manage'),
        ('admin', 'org.manage'), ('manager', 'org.manage'), ('manager', 'team.report.view')
      ) as p(role, perm) on p.role = r.code
     where r.company_id = c.id
    on conflict do nothing;
  end loop;
end $$;
