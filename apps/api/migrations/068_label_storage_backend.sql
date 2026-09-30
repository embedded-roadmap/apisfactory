-- Oturum 41 devamı — S3 uyumlu depolama geçişi: her nesne kaydı hangi depolamada durduğunu tutar (mesaj ekleri, fason
-- dosyaları ve hazırlanan yüklemelerde zaten var). Kargo etiketine de eklenir; mevcut etiketler yerel diskte.
alter table shipments add column label_storage_backend text check (label_storage_backend in ('local', 's3'));
do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    update shipments set label_storage_backend = 'local' where label_object_key is not null and label_storage_backend is null;
  end loop;
end $$;

-- Nesne tabloları değişmezdir; TEK istisna depolama taşımasıdır: yalnız storage_backend 'local' → 's3' olabilir, diğer her
-- alan aynı kalmalıdır (scripts/migrate-storage.mjs, nesne S3'e yazılıp geri okunarak doğrulandıktan sonra). Silme yine yasak.
create or replace function allow_storage_move_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.storage_backend = 'local' and new.storage_backend = 's3'
     and (to_jsonb(new) - 'storage_backend') = (to_jsonb(old) - 'storage_backend') then
    return new;
  end if;
  raise exception 'append_only: % tablosunda % yapılamaz; düzeltme yeni kayıtla yapılır', tg_table_name, tg_op using errcode = 'P0001';
end $$;
drop trigger message_attachments_append_only on message_attachments;
create trigger message_attachments_append_only before update or delete on message_attachments for each row execute function allow_storage_move_only();
drop trigger subcontract_job_files_append_only on subcontract_job_files;
create trigger subcontract_job_files_append_only before update or delete on subcontract_job_files for each row execute function allow_storage_move_only();
