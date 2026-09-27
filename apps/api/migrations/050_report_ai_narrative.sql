-- Oturum 41 (dış bağımlılık maddesi 3 — AI yorum katmanı, sağlayıcı: Anthropic Claude).
-- AI yalnız kural tabanlı bulgunun üstüne serbest metin YORUM ekler; bulgunun sayısal alanları, cause_type
-- ('confirmed' asla) ve eylem seçenekleri değişmez. Hangi modelin, ne zaman, kimin isteğiyle ürettiği izlenir.
alter table report_findings add column ai_model text;
alter table report_findings add column ai_generated_at timestamptz;
alter table report_findings add column ai_generated_by uuid references users(id);
alter table report_findings add constraint report_findings_ai_generated_complete
  check (ai_status <> 'generated' or (ai_narrative is not null and ai_model is not null and ai_generated_at is not null));
