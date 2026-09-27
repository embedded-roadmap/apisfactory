-- R47: şirketin tam veri ve dosya çıkış paketi.
-- "Şirketin çıkış paketi kayıtları, kimlikleri, ilişkileri, dosyaları ve veri sözlüğünü birlikte
-- içersin. Yalnızca birkaç PDF sunup tam veri çıkışı sağlandı deme. Bütün import/export ve
-- indirmeler kayıt altına alınsın." (ana talimat §21). Yeni tablo gerekmiyor — export mevcut
-- `events` denetim iziyle kaydedilir (companyExportRoutes, company-export.ts); yalnızca yeni
-- yetki eklenir.

-- Çok geniş/hassas bir işlem (şirketin TÜM verisi + kullanıcı e-postaları) — mevcut iş
-- yetkilerinden (satış, muhasebe vb.) ayrı, sistemsel bir yönetici yetkisi olarak tanımlandı
-- (org.manage/audit.view ile aynı düzeyde; "teknik yönetici iş kararı onaylayamaz" kuralına
-- aykırı değil çünkü bu bir iş kararı değil, sistemsel bir veri işlemidir).
do $$
declare c record;
begin
  for c in select id from companies loop
    perform set_config('app.company_id', c.id::text, true);
    insert into role_permissions (company_id, role_id, permission)
    select c.id, r.id, 'company.data.export' from roles r
     where r.company_id = c.id and r.code = 'admin'
    on conflict do nothing;
  end loop;
end $$;
