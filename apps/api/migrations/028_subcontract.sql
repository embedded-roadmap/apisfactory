-- W32: Fason üretici portalı, dosya ve malzeme teyidi (prompt §19).
-- Dış kullanıcı erişimi genel izinlerle DEĞİL, kendisine atanmış işle sınırlanır
-- (subcontract_jobs.subcontractor_user_id = oturum sahibi); memberships.is_external zaten mevcuttu.

create table subcontract_jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  code text not null,
  subcontractor_user_id uuid not null references users(id),
  kind text not null check (kind in ('pcb', 'dizgi', 'mekanik', 'kablo', 'montaj', 'dis_test')),
  product_revision_id uuid references product_revisions(id),
  scope text not null,
  qty numeric(18, 6) not null check (qty > 0),
  promised_date date,
  price numeric(18, 2),
  currency text not null default 'TRY',
  company_supplies text,        -- şirketin sağlayacağı malzeme/dosya
  subcontractor_supplies text,  -- fason firmanın sağlayacağı malzeme
  tech_package_note text,       -- paylaşılan teknik paket sürümü (dosya deposu W08'de; şimdilik not)
  status text not null default 'proposed'
    check (status in ('proposed', 'countered', 'accepted', 'rejected', 'prep', 'in_production', 'testing', 'ready_to_ship', 'completed', 'cancelled')),
  counter_price numeric(18, 2),
  counter_promised_date date,
  counter_note text,
  declared_good_qty numeric(18, 6),
  declared_scrap_qty numeric(18, 6),
  declared_unused_qty numeric(18, 6),
  declared_note text,
  declared_at timestamptz,
  accepted_good_qty numeric(18, 6),
  accepted_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (company_id, code)
);

create table subcontract_job_files (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  job_id uuid not null references subcontract_jobs(id),
  kind text not null check (kind in ('photo', 'video', 'test_report', 'delivery_doc')),
  file_name text not null,
  content_type text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'application/pdf', 'text/plain', 'text/csv')),
  size_bytes int not null check (size_bytes > 0 and size_bytes <= 20_000_000),
  sha256 text not null,
  content bytea not null,
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now()
);
create trigger subcontract_job_files_append_only before update or delete on subcontract_job_files for each row execute function forbid_mutation();

do $$
declare t text;
begin
  foreach t in array array['subcontract_jobs', 'subcontract_job_files'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update on subcontract_jobs to apis_app;
grant select, insert on subcontract_job_files to apis_app;
