-- Oturum 37 (W27, kullanıcının 2026-09-26 devam talimatı §2): nesne depolama altyapısı ve video eki desteği.
-- Var olan `content bytea` sütunu KORUNUR — eski satırlar hâlâ oradan okunur ("erişim doğrulanmadan
-- eski içeriği silme" kuralı gereği bu oturumda taşınmadı/silinmedi; bu, devam notunda açık bir
-- kalan olarak işaretlenmiştir). Yeni satırlar (özellikle video, boyutu nedeniyle) nesne depolamaya
-- yazılır: `content` NULL, `object_key`/`storage_backend` dolu olur. İkisi birden dolu/boş olamaz
-- (aşağıdaki check constraint).
alter table message_attachments alter column content drop not null;
alter table message_attachments add column object_key text;
alter table message_attachments add column storage_backend text;
alter table message_attachments add column duration_seconds numeric(8, 2);
alter table message_attachments drop constraint message_attachments_content_type_check;
alter table message_attachments add constraint message_attachments_content_type_check
  check (content_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv', 'video/mp4', 'video/webm'));
alter table message_attachments add constraint message_attachments_storage_check
  check ((object_key is not null and storage_backend is not null and content is null)
      or (object_key is null and storage_backend is null and content is not null));

alter table subcontract_job_files alter column content drop not null;
alter table subcontract_job_files add column object_key text;
alter table subcontract_job_files add column storage_backend text;
alter table subcontract_job_files add column duration_seconds numeric(8, 2);
alter table subcontract_job_files add constraint subcontract_job_files_storage_check
  check ((object_key is not null and storage_backend is not null and content is null)
      or (object_key is null and storage_backend is null and content is not null));

-- Video, boyutu nedeniyle tek bir JSON mesaj gövdesinde base64 olarak gönderilemez (istek gövdesi
-- 8 MB ile sınırlı). Önce ayrı bir ham-ikili yükleme ucuna gider (gerçek süre/tür sunucuda
-- doğrulanır), sonra mesaja veya fason işe "iliştirilir" (consumed_at doldurulur). Kullanılmamış
-- (terk edilmiş) yüklemelerin temizlenmesi bu oturumun kapsamında değildir — bilinen kalan.
create table staged_uploads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  uploaded_by uuid references users(id),
  file_name text not null check (length(file_name) between 1 and 200),
  content_type text not null check (content_type in ('video/mp4', 'video/webm')),
  size_bytes int not null check (size_bytes > 0),
  duration_seconds numeric(8, 2) not null,
  sha256 text not null,
  object_key text not null,
  storage_backend text not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index staged_uploads_company_idx on staged_uploads (company_id, consumed_at);

do $$
declare t text;
begin
  foreach t in array array['staged_uploads'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (company_id = app_company_id()) with check (company_id = app_company_id())', t);
  end loop;
end $$;
grant select, insert, update on staged_uploads to apis_app;
