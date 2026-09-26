-- W10 devamı: iki seviyeli yükseltme. "Bilinen sorunlar ve sınırlar": "Yükseltme tek seviye
-- (üst rolün de süresi dolarsa ikinci yükseltme yok)". İsteğe bağlı ikinci üst rol (escalate_to_role_2)
-- tanımlanmazsa davranış birebir eskisi gibi kalır (geriye dönük uyumlu, yeni sütunlar nullable).
alter table approval_policies add column escalate_to_role_2 text;
alter table tasks add column escalation_policy_kind text;
