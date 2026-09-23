import pg from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DEFAULT_ROLES, type RoleCode } from "@apisfactory/shared";
import { config } from "../config";
import { hashPassword } from "../lib/auth";

/**
 * Temel şirket kurulumu: roller (izinleriyle), varsayılan konumlar, departmanlar.
 * Şema sahibi bağlantısıyla, şirket bağlamı ayarlanarak çalışır (RLS politikaları geçerli kalır).
 */
export async function createCompany(client: pg.Client, input: { code: string; name: string; isDemo?: boolean }) {
  const c = await client.query(`insert into companies (code, name, is_demo) values ($1, $2, $3) returning id`, [input.code, input.name, input.isDemo ?? false]);
  const companyId: string = c.rows[0].id;
  await client.query(`select set_config('app.company_id', $1, false)`, [companyId]);
  const roleIds: Record<string, string> = {};
  for (const [code, def] of Object.entries(DEFAULT_ROLES)) {
    const r = await client.query(`insert into roles (company_id, code, name) values ($1, $2, $3) returning id`, [companyId, code, def.name.tr]);
    roleIds[code] = r.rows[0].id;
    for (const p of def.permissions) {
      await client.query(`insert into role_permissions (company_id, role_id, permission) values ($1, $2, $3)`, [companyId, r.rows[0].id, p]);
    }
  }
  const site = await client.query(`insert into sites (company_id, code, name) values ($1, 'MRK', 'Merkez tesis') returning id`, [companyId]);
  for (const [code, name] of [["SAT", "Satış"], ["MUH", "Muhasebe"], ["SAL", "Satın alma"], ["URT", "Üretim"], ["ARG", "Ar-Ge"], ["KAL", "Kalite"], ["DEP", "Depo"]]) {
    await client.query(`insert into departments (company_id, code, name) values ($1, $2, $3)`, [companyId, code, name]);
  }
  // Varsayılan kapasite ve standart süreler (şirket kendi değerleriyle değiştirir; W16).
  for (const [code, name, kind, setup, perUnit] of [
    ["HAZ", "Malzeme hazırlama", "prep", 30, 0.2],
    ["SMT", "Dizgi hattı", "smt", 90, 0.5],
    ["LEH", "Lehim / THT", "manual", 15, 2],
    ["PRG", "Programlama", "programming", 10, 1],
    ["TST", "Fonksiyon testi", "test", 15, 3],
    ["MON", "Mekanik montaj", "assembly", 10, 4],
  ] as const) {
    await client.query(
      `insert into work_centers (company_id, code, name, kind, setup_minutes, minutes_per_unit) values ($1, $2, $3, $4, $5, $6)`,
      [companyId, code, name, kind, setup, perUnit],
    );
  }
  const locations: Record<string, string> = {};
  for (const [code, name, type] of [
    ["STK", "Ana depo", "stock"],
    ["GKK", "Giriş kalite kontrol alanı", "incoming_inspection"],
    ["KRN", "Karantina", "quarantine"],
    ["URT", "Üretim hattı", "production"],
    ["FSN", "Fason üretici", "subcontractor"],
    ["BTM", "Bitmiş ürün deposu", "finished"],
    ["IAD", "İade kabul alanı", "returns"],
  ]) {
    const l = await client.query(`insert into locations (company_id, site_id, code, name, type) values ($1, $2, $3, $4, $5) returning id`, [
      companyId,
      site.rows[0].id,
      code,
      name,
      type,
    ]);
    locations[code!] = l.rows[0].id;
  }
  return { companyId, roleIds, locations };
}

export async function createUser(
  client: pg.Client,
  input: { email: string; name: string; password: string; companyId: string; roles: RoleCode[]; roleIds: Record<string, string> },
) {
  const existing = await client.query(`select id from users where email = $1`, [input.email]);
  const userId: string =
    existing.rows[0]?.id ??
    (await client.query(`insert into users (email, name, password_hash) values ($1, $2, $3) returning id`, [input.email, input.name, await hashPassword(input.password)]))
      .rows[0].id;
  await client.query(`select set_config('app.company_id', $1, false)`, [input.companyId]);
  const m = await client.query(`insert into memberships (company_id, user_id) values ($1, $2) returning id`, [input.companyId, userId]);
  for (const r of input.roles) {
    await client.query(`insert into membership_roles (company_id, membership_id, role_id) values ($1, $2, $3)`, [input.companyId, m.rows[0].id, input.roleIds[r]]);
  }
  return userId;
}

export const DEMO_PASSWORD = "demo1234!";

/** DEMO etiketli örnek elektronik şirketi ve yetki ayrımını göstermek için ikinci bir şirket (prompt §31). */
async function seedDemo() {
  const client = new pg.Client({ connectionString: config.migrationDatabaseUrl });
  await client.connect();
  try {
    const exists = await client.query(`select 1 from companies where code = 'DEMO-ELK'`);
    if (exists.rowCount) {
      console.log("Demo veri zaten var; atlandı.");
      return;
    }
    await client.query("begin");
    const a = await createCompany(client, { code: "DEMO-ELK", name: "DEMO Elektronik A.Ş.", isDemo: true });
    const users: [string, string, RoleCode[]][] = [
      ["yonetici@demo.apisfactory.com", "Demo Yönetici", ["manager"]],
      ["arge@demo.apisfactory.com", "Demo Ar-Ge Mühendisi", ["rd"]],
      ["uretim@demo.apisfactory.com", "Demo Üretim Sorumlusu", ["production"]],
      ["kalite@demo.apisfactory.com", "Demo Kalite", ["quality"]],
      ["depo@demo.apisfactory.com", "Demo Depo", ["warehouse"]],
      ["satis@demo.apisfactory.com", "Demo Satış", ["sales"]],
      ["satinalma@demo.apisfactory.com", "Demo Satın Alma", ["purchasing"]],
      ["muhasebe@demo.apisfactory.com", "Demo Muhasebe", ["accounting"]],
      ["teknisyen@demo.apisfactory.com", "Demo Teknisyen", ["technician"]],
      ["admin@demo.apisfactory.com", "Demo Sistem Yöneticisi", ["admin"]],
    ];
    for (const [email, name, roles] of users) {
      await createUser(client, { email, name, password: DEMO_PASSWORD, companyId: a.companyId, roles, roleIds: a.roleIds });
    }
    await client.query(`select set_config('app.company_id', $1, false)`, [a.companyId]);
    const cust = await client.query(`insert into customers (company_id, code, name) values ($1, 'MUS-001', 'DEMO Müşteri Otomasyon Ltd.') returning id`, [a.companyId]);
    // Sentetik teslim adresi (gerçek kişi/firma verisi değildir)
    await client.query(
      `insert into customer_addresses (company_id, customer_id, label, recipient, line1, district, city, is_default) values ($1, $2, 'Merkez depo (DEMO)', 'Demo Teslim Alan', 'Örnek OSB 1. Cad. No:1', 'Tuzla', 'İstanbul', true)`,
      [a.companyId, cust.rows[0].id],
    );
    // Sentetik komponentler: gerçek MPN'ler hakkında uyumluluk iddiası taşımaz (prompt §31).
    for (const [code, name, mfr, mpn] of [
      ["CMP-MCU-01", "MCU 32-bit QFN-48 (DEMO)", "DemoSemi", "DS32F100-Q48"],
      ["CMP-LDO-01", "LDO 3V3 SOT-23-5 (DEMO)", "DemoPower", "DP3301-33"],
      ["CMP-CAP-01", "Kondansatör 10µF 16V 0603 (DEMO)", "DemoPassive", "DPC0603X106"],
      ["CMP-CON-01", "Konnektör 2x5 1.27mm (DEMO)", "DemoConn", "DCN-2X5-127"],
      // W29: kural tabanlı alternatif adayı örneği (onaysız; uyumluluk iddiası yoktur)
      ["CMP-CAP-02", "Kondansatör 10µF 16V 0603 X5R (DEMO)", "DemoPassive2", "DP2-0603-106"],
    ]) {
      await client.query(`insert into items (company_id, code, name, kind, manufacturer, mpn) values ($1,$2,$3,'component',$4,$5)`, [a.companyId, code, name, mfr, mpn]);
    }

    // Örnek ekipman ve tatil (DEMO)
    await client.query(`insert into equipment (company_id, code, name, kind, calibration_due) values ($1,'TST-01','Fonksiyon test istasyonu 1 (DEMO)','test_station', current_date + 180), ($1,'DMM-01','Multimetre (DEMO)','measuring', current_date - 5)`, [a.companyId]);
    await client.query(`update items set lead_time_days = 21 where company_id = $1 and kind = 'component'`, [a.companyId]);
    // Örnek organizasyon ve plan (DEMO): departman yöneticileri/üyeleri ve bağımlı üç görev
    await client.query(
      `insert into department_members (company_id, department_id, user_id, is_manager, valid_from)
       select $1, d.id, u.id, x.mgr, date_trunc('year', current_date)
         from (values ('URT', 'uretim@demo.apisfactory.com', true), ('URT', 'teknisyen@demo.apisfactory.com', false),
                      ('KAL', 'kalite@demo.apisfactory.com', true), ('ARG', 'arge@demo.apisfactory.com', true),
                      ('DEP', 'depo@demo.apisfactory.com', true), ('SAT', 'satis@demo.apisfactory.com', true),
                      ('SAL', 'satinalma@demo.apisfactory.com', true), ('MUH', 'muhasebe@demo.apisfactory.com', true)) as x(dep, email, mgr)
         join departments d on d.company_id = $1 and d.code = x.dep join users u on u.email = x.email`,
      [a.companyId],
    );
    const demoTasks = await client.query(
      `insert into tasks (company_id, title, assignee_user_id, department_id, priority, start_date, due_date, milestone, checklist, entity_type, entity_id, kind)
       select $1, x.title, u.id, d.id, x.pri, current_date + x.s, current_date + x.e, x.ms, x.cl::jsonb, 'task', gen_random_uuid(), 'manual'
         from (values
           (1, 'Pilot üretim fikstürü hazırlığı (DEMO)', 'teknisyen@demo.apisfactory.com', 'URT', 'high', 1, 4, false, '[{"text":"Fikstür pim kontrolü","done":false},{"text":"Programlama kablosu","done":false}]'),
           (2, 'Pilot test planı gözden geçirme (DEMO)', 'kalite@demo.apisfactory.com', 'KAL', 'normal', 5, 7, false, '[]'),
           (3, 'Seri üretime geçiş kararı (DEMO)', 'uretim@demo.apisfactory.com', 'URT', 'critical', 9, 9, true, '[]')
         ) as x(n, title, email, dep, pri, s, e, ms, cl)
         join users u on u.email = x.email join departments d on d.company_id = $1 and d.code = x.dep
        returning id, title`,
      [a.companyId],
    );
    const tid = (p: string) => demoTasks.rows.find((r) => r.title.startsWith(p))!.id;
    const [t1, t2, t3] = [tid('Pilot üretim'), tid('Pilot test'), tid('Seri üretime')];
    await client.query(`update tasks set entity_id = id where id = any($1)`, [[t1, t2, t3]]);
    await client.query(`insert into task_dependencies (company_id, task_id, depends_on_id) values ($1, $2, $3), ($1, $4, $2)`, [a.companyId, t2, t1, t3]);
    // Örnek maliyet politikası (DEMO değerleri; gerçek muhasebe politikası değildir)
    await client.query(
      `insert into cost_policies (company_id, version_no, valid_from, currency, labor_rate_per_hour, overhead_per_labor_hour, overhead_pct_of_material, note)
       values ($1, 1, date_trunc('year', current_date), 'TRY', 600, 150, 10, 'DEMO politika: işçilik 600 TL/saat, genel gider 150 TL/saat + malzemenin %10''u')`,
      [a.companyId],
    );

    // DEMO tedarikçiler (gerçek firma değildir; tedarikçiye gönderim test modunda)
    await client.query(
      `insert into suppliers (company_id, code, name, contact_email, default_lead_time_days) values
         ($1, 'DEMO-DAG', 'DEMO Dağıtıcı A.Ş.', 'siparis@dagitici.demo.apisfactory.com', 14),
         ($1, 'DEMO-YRL', 'DEMO Yerel Elektronik', 'satis@yerel.demo.apisfactory.com', 5)`,
      [a.companyId],
    );

    const b = await createCompany(client, { code: "DEMO-IKI", name: "DEMO İkinci Şirket (izolasyon testi)", isDemo: true });
    await createUser(client, { email: "yonetici@ikinci.demo.apisfactory.com", name: "İkinci Şirket Yöneticisi", password: DEMO_PASSWORD, companyId: b.companyId, roles: ["manager", "rd", "sales", "warehouse"], roleIds: b.roleIds });
    await client.query("commit");
    console.log(`Demo veri oluşturuldu. Parola: ${DEMO_PASSWORD}`);
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seedDemo().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
