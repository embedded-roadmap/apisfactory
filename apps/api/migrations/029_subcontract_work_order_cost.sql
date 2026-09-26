-- W32 devamı: fason (dış hizmet) maliyetinin iş emri maliyetine yansıtılması (prompt §18/§19).
-- Fason iş isteğe bağlı olarak bir iş emrine bağlanabilir (elle seçilir — sunucu tahmin etmez);
-- bağlıysa ve iş TAMAMLANDIYSA (accepted_good_qty/price nihaileşmiş), anlaşılan fiyat maliyet
-- hesabında "dış hizmet" kalemi olarak sayılır (computeWorkOrderCost, apps/api/src/modules/costing.ts).

alter table subcontract_jobs add column work_order_id uuid references work_orders(id);
