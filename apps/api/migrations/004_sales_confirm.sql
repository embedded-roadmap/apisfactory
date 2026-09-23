-- Kesinleştirme sonucu siparişle birlikte saklanır; tekrar gelen onay aynı sonucu döner (T04).
alter table sales_orders add column confirm_result jsonb;
