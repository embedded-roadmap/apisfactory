-- Oturum 41 devamı — R14: teklif talebinde onaylı alternatif. Tedarikçi istenen kalem yerine GENEL (ürüne bağlı olmayan)
-- onaylı alternatif için teklif verebilir; aynı tedarikçinin istenen kalem ve alternatif için ayrı teklifi olabilir.
alter table rfq_quotes add column offered_item_id uuid references items(id);
alter table rfq_quotes drop constraint rfq_quotes_rfq_id_supplier_id_key;
create unique index rfq_quotes_rfq_supplier_item on rfq_quotes (rfq_id, supplier_id, coalesce(offered_item_id, '00000000-0000-0000-0000-000000000000'::uuid));
