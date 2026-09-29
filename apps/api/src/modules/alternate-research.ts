import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { USABLE_LOCATION_TYPES } from "@apisfactory/shared";
import type { Db } from "../db/pool";
import { conflict, forbidden, notFound } from "../lib/errors";
import { openTask, recordEvent } from "../lib/records";
import { can, parse, tenant } from "../http/context";
import { aiConfig } from "../lib/ai-call";
import {
  CATEGORY_RULES, PROMPT_VERSION, RULES_VERSION, SUPPORTED_CATEGORIES, applyRules, missingInputs, runAiComparison,
  type Doc, type ResearchInput,
} from "../lib/alternate-research";
import { loadAlternate } from "./alternates";

/**
 * R12 — "AI'ya sor / Alternatif bul" (ana talimat §11). Ayrıntı: lib/alternate-research.ts.
 * Çağırabilen: Ar-Ge (product.create) veya yetkili üretim (product.approve.production).
 * Önce kalemin mevcut onaylı alternatifleri döner; araştırma yalnız verilen adaylar ve belgelerle yapılır (serbest web
 * araması yok — distribütör/üretici verisinin lisans kısıtları için bkz. docs/w03-distributor-erisim-matrisi.md).
 * Her koşu (girdi özeti, model, prompt ve kural sürümü) ve aday sonucu değişmez kaydedilir; öneriye dönüştürme insan kararıdır.
 */

async function freeStock(db: Db, itemId: string) {
  const r = await db.query(
    `select coalesce((select sum(b.qty) from stock_balances b join locations l on l.id = b.location_id where b.item_id = $1 and l.type = any($2)), 0)::float8 as stock,
            coalesce((select sum(qty) from reservations where item_id = $1 and status = 'active'), 0)::float8 as reserved`,
    [itemId, USABLE_LOCATION_TYPES],
  );
  return Math.max(0, r.rows[0].stock - r.rows[0].reserved);
}

/** Aday için stok ve son distribütör teklifi (deterministik; AI'dan gelmez). */
async function supplyOf(db: Db, itemId: string) {
  const offer = (await db.query(
    `select dc.name as source, po.stock, po.moq, po.lead_time_days as "leadTimeDays", po.currency, po.price_breaks as breaks, po.fetched_at as "fetchedAt"
       from part_offers po join distributor_connectors dc on dc.id = po.connector_id
      where po.item_id = $1 order by po.fetched_at desc limit 1`,
    [itemId],
  )).rows[0] ?? null;
  return { freeStock: await freeStock(db, itemId), offer };
}

async function loadRun(db: Db, id: string) {
  const run = (await db.query(
    `select r.id, r.item_id as "itemId", i.code as "itemCode", i.mpn as "itemMpn", r.product_id as "productId", r.category, r.rules_version as "rulesVersion",
            r.prompt_version as "promptVersion", r.model, r.inputs, r.missing_inputs as "missingInputs", r.input_hash as "inputHash",
            u.name as "createdBy", r.created_at as "createdAt"
       from alternate_research_runs r join items i on i.id = r.item_id left join users u on u.id = r.created_by where r.id = $1`,
    [id],
  )).rows[0];
  if (!run) throw notFound("Araştırma");
  const candidates = (await db.query(
    `select c.id, c.ref, c.candidate_item_id as "candidateItemId", c.mpn, c.manufacturer, c.name, c.source, c.verdict, c.fields, c.pin_map as "pinMap",
            c.rule_findings as "ruleFindings", c.test_needs as "testNeeds", c.design_changes as "designChanges", c.summary, c.supply,
            (select a.id from item_alternates a where a.research_candidate_id = c.id order by a.proposed_at desc limit 1) as "proposalId"
       from alternate_research_candidates c where c.run_id = $1 order by c.ref`,
    [id],
  )).rows;
  return { ...run, candidates };
}

const DocInput = z.object({ title: z.string().min(2).max(200), text: z.string().min(20).max(30000) });

export async function alternateResearchRoutes(app: FastifyInstance) {
  app.get("/api/alternate-research/categories", async (req) =>
    tenant(req, "bom.view", async () => ({
      rulesVersion: RULES_VERSION,
      categories: Object.entries(CATEGORY_RULES).map(([key, r]) => ({ key, label: r.label, pinout: r.pinout, criticalFields: r.critical })),
      note: "Bu kategoriler dışındaki parçalar yalnız 'araştırma adayı' olarak işaretlenir; doğrulanmış kural kapsamında değildir.",
      aiAvailable: aiConfig().available,
    })),
  );

  app.get("/api/items/:id/alternate-research", async (req) => {
    const { id } = req.params as { id: string };
    return tenant(req, "bom.view", async (db) =>
      (await db.query(
        `select r.id, r.category, r.model, r.created_at as "createdAt", u.name as "createdBy",
                (select count(*) from alternate_research_candidates c where c.run_id = r.id)::int as candidates,
                (select count(*) from alternate_research_candidates c where c.run_id = r.id and c.verdict = 'candidate')::int as "passing"
           from alternate_research_runs r left join users u on u.id = r.created_by where r.item_id = $1 order by r.created_at desc`,
        [id],
      )).rows,
    );
  });

  app.get("/api/alternate-research/:id", async (req) => tenant(req, "bom.view", (db) => loadRun(db, (req.params as { id: string }).id)));

  app.post("/api/items/:id/alternate-research", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(
      z.object({
        category: z.string().min(2).max(40),
        productId: z.string().uuid().optional(),
        application: z.string().max(1000).optional(),
        temperature: z.string().max(100).optional(),
        targetQty: z.string().max(100).optional(),
        primaryDatasheet: DocInput.optional(),
        schematic: DocInput.optional(),
        firmwareEvidence: z.string().max(4000).optional(),
        candidateItemIds: z.array(z.string().uuid()).max(5).default([]),
        externalCandidates: z.array(z.object({ mpn: z.string().min(2).max(80), manufacturer: z.string().min(2).max(120), datasheet: DocInput.optional() })).max(5).default([]),
        candidateDatasheets: z.record(z.string().uuid(), DocInput).default({}),
      }),
      req.body,
    );
    if (!can(req, "product.create") && !can(req, "product.approve.production")) throw forbidden("product.create");
    return tenant(req, null, async (db, actor) => {
      const it = (await db.query(`select id, code, name, kind, mpn, manufacturer, lifecycle from items where id = $1`, [id])).rows[0];
      if (!it) throw notFound("Kalem");
      // Önce onaylı alternatifler (§11): varsa araştırmayla birlikte gösterilir.
      const approved = (await db.query(
        `select a.id, x.code, x.mpn, x.manufacturer, a.product_id as "productId" from item_alternates a join items x on x.id = a.alternate_item_id
          where a.item_id = $1 and a.status = 'approved' and ($2::uuid is null or a.product_id is null or a.product_id = $2)`,
        [id, input.productId ?? null],
      )).rows;
      if (!input.candidateItemIds.length && !input.externalCandidates.length) {
        throw conflict("no_candidates", approved.length
          ? `Karşılaştırılacak aday seçilmedi. Bu parçanın ${approved.length} onaylı alternatifi zaten var.`
          : "Karşılaştırılacak aday seçilmedi: kalem kartından aday seçin veya MPN + datasheet alıntısıyla dış aday ekleyin.");
      }
      const items = input.candidateItemIds.length
        ? (await db.query(`select id, code, name, kind, mpn, manufacturer from items where id = any($1)`, [input.candidateItemIds])).rows
        : [];
      if (items.length !== input.candidateItemIds.length) throw notFound("Aday kalem");
      if (items.some((x) => x.id === id)) throw conflict("same_item", "Parça kendisinin alternatifi olamaz");
      if (items.some((x) => x.kind !== it.kind)) throw conflict("kind_mismatch", "Aday aynı türde kalem olmalı");

      const docs: Doc[] = [];
      if (input.primaryDatasheet) docs.push({ id: "D0", ...input.primaryDatasheet });
      if (input.schematic) docs.push({ id: "S0", ...input.schematic });
      const candidates: ResearchInput["candidates"] = [];
      items.forEach((x, i) => {
        const ref = `C${i + 1}`;
        const ds = input.candidateDatasheets[x.id];
        const docIds: string[] = [];
        if (ds) { docs.push({ id: `D${ref}`, ...ds }); docIds.push(`D${ref}`); }
        candidates.push({ ref, mpn: x.mpn, manufacturer: x.manufacturer, name: x.name, docIds });
      });
      input.externalCandidates.forEach((x, i) => {
        const ref = `X${i + 1}`;
        const docIds: string[] = [];
        if (x.datasheet) { docs.push({ id: `D${ref}`, ...x.datasheet }); docIds.push(`D${ref}`); }
        candidates.push({ ref, mpn: x.mpn, manufacturer: x.manufacturer, name: x.mpn, docIds });
      });
      const research: ResearchInput = {
        category: input.category,
        primary: { mpn: it.mpn, manufacturer: it.manufacturer, name: it.name, lifecycle: it.lifecycle },
        application: input.application ?? null, temperature: input.temperature ?? null, targetQty: input.targetQty ?? null,
        schematicProvided: Boolean(input.schematic), firmwareEvidence: input.firmwareEvidence ?? null, docs, candidates,
      };
      const missing = missingInputs(research);
      const ai = await runAiComparison(research);
      const inputHash = createHash("sha256").update(JSON.stringify(research)).digest("hex");
      const run = await db.query(
        `insert into alternate_research_runs (company_id, item_id, product_id, category, rules_version, prompt_version, model, inputs, missing_inputs, input_hash, created_by)
         values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [id, input.productId ?? null, input.category, RULES_VERSION, PROMPT_VERSION, ai.model,
          // Belge metinleri özet olarak saklanır (kimlik, başlık, uzunluk, sha256) — tam metin kaydı gerekmez, iz sürülebilir.
          JSON.stringify({ ...research, docs: docs.map((d) => ({ id: d.id, title: d.title, chars: d.text.length, sha256: createHash("sha256").update(d.text).digest("hex") })) }),
          missing, inputHash, actor.userId],
      );
      const runId = run.rows[0].id as string;
      for (const c of candidates) {
        const r = applyRules(research, ai.candidates.find((x) => x.ref === c.ref));
        const aiC = ai.candidates.find((x) => x.ref === c.ref);
        const item = items[Number(c.ref.slice(1)) - 1];
        const supply = c.ref.startsWith("C") && item ? await supplyOf(db, item.id) : null;
        await db.query(
          `insert into alternate_research_candidates (company_id, run_id, ref, candidate_item_id, mpn, manufacturer, name, source, verdict, fields, pin_map,
                                                      rule_findings, test_needs, design_changes, summary, supply)
           values (app_company_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [runId, c.ref, c.ref.startsWith("C") ? item!.id : null, c.mpn, c.manufacturer, c.name, c.ref.startsWith("C") ? "item_master" : "user_supplied",
            r.verdict, JSON.stringify(r.fields), JSON.stringify(r.pinMap), JSON.stringify(r.findings), JSON.stringify(aiC?.testNeeds ?? []),
            JSON.stringify(aiC?.designChanges ?? []), aiC?.summary ?? null, supply === null ? null : JSON.stringify(supply)],
        );
      }
      await recordEvent(db, actor, {
        entityType: "item", entityId: id, eventType: "alternate_research.run",
        after: { runId, category: input.category, model: ai.model, promptVersion: PROMPT_VERSION, rulesVersion: RULES_VERSION, inputHash, candidates: candidates.map((c) => c.mpn ?? c.name), missingInputs: missing },
      });
      return { ...(await loadRun(db, runId)), approvedAlternates: approved, supportedCategories: SUPPORTED_CATEGORIES };
    });
  });

  /**
   * İnsan kararı: araştırma adayını onay akışına öneri olarak gönder. Kalem kartında olmayan dış aday için önce kalem
   * açılmalı ve `alternateItemId` verilmeli. Kural kararı "kuralla elendi" olan aday gerekçeyle bile öneri yapılamaz.
   */
  app.post("/api/alternate-research/candidates/:id/propose", async (req) => {
    const { id } = req.params as { id: string };
    const input = parse(z.object({ alternateItemId: z.string().uuid().optional(), productId: z.string().uuid().optional(), reason: z.string().min(10).max(1000) }), req.body);
    if (!can(req, "product.create")) throw forbidden("product.create");
    return tenant(req, null, async (db, actor) => {
      const c = (await db.query(
        `select c.*, r.item_id, r.product_id as run_product_id, r.model, r.rules_version from alternate_research_candidates c
           join alternate_research_runs r on r.id = c.run_id where c.id = $1`,
        [id],
      )).rows[0];
      if (!c) throw notFound("Araştırma adayı");
      if (c.verdict === "rejected_by_rules") throw conflict("rejected_by_rules", "Aday kategori kurallarıyla elendi (uyumsuz kritik alan); öneri yapılamaz");
      const altId = c.candidate_item_id ?? input.alternateItemId;
      if (!altId) throw conflict("item_required", "Dış aday için önce kalem kartı açın ve alternateItemId verin");
      const kinds = (await db.query(`select id, kind, mpn from items where id = any($1)`, [[c.item_id, altId]])).rows;
      if (kinds.length !== 2) throw notFound("Kalem");
      if (kinds[0].kind !== kinds[1].kind) throw conflict("kind_mismatch", "Alternatif aynı türde kalem olmalı");
      const fields = c.fields as { key: string; status: string; label: string }[];
      const st = (k: string) => fields.find((f) => f.key === k)?.status;
      const tri = (s: string | undefined) => (s === "compatible" ? true : s === "incompatible" ? false : null);
      const evidence = [
        `AI araştırması ${c.run_id} (model ${c.model}, kural v${c.rules_version}) — karar: ${c.verdict}.`,
        ...fields.map((f) => `${f.label}: ${f.status}`),
        ...((c.rule_findings as string[]) ?? []).map((x) => `Kural: ${x}`),
      ].join("\n");
      const r = await db.query(
        `insert into item_alternates (company_id, item_id, alternate_item_id, product_id, origin, reason, pin_compatible, footprint_same, electrical_equivalent, evidence, proposed_by, research_candidate_id)
         values (app_company_id(), $1, $2, $3, 'ai_research', $4, $5, $6, null, $7, $8, $9) returning id`,
        [c.item_id, altId, input.productId ?? c.run_product_id ?? null, input.reason, tri(st("pinout")), tri(st("package") ?? st("footprint")), evidence, actor.userId, id],
      ).catch((e) => { if (e.code === "23505") throw conflict("alternate_exists", "Bu alternatif için açık öneri veya onay zaten var"); throw e; });
      const altRowId = r.rows[0].id as string;
      for (const area of ["rd", "production"] as const) {
        await openTask(db, actor.companyId, { kind: "alternate_approval", title: `Alternatif parça onayı (${area === "rd" ? "Ar-Ge" : "üretim"}) — AI araştırması`, entityType: "item_alternate", entityId: altRowId, assigneeRole: area });
      }
      await recordEvent(db, actor, { entityType: "item_alternate", entityId: altRowId, eventType: "proposed", after: { origin: "ai_research", researchCandidateId: id, verdict: c.verdict }, reason: input.reason });
      return loadAlternate(db, altRowId);
    });
  });
}
