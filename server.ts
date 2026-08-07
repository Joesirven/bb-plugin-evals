import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { formatNativeCheckSummary, runNativeSessionChecks } from "./evalSessionNative";

const execFileAsync = promisify(execFile);

/**
 * The eval ratchet, ported from Meadow's tools/eval_ratchet.py.
 *
 * The invariant that makes this a ratchet and not a suggestion box: this plugin
 * owns the proposal record and exposes NO apply operation. It can propose and it
 * can read. There is no code path anywhere in this file that writes to a target
 * document. Adoption is a human editing a doc.
 *
 * The second invariant: fixtures are sealed by a hash manifest. If the fixtures
 * drift, scoring REFUSES rather than silently optimizing against a moving target.
 */

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

const LAYERS = ["deterministic", "judge"] as const;
const RUN_STATUS = ["running", "complete", "refused", "failed"] as const;
const PROPOSAL_STATUS = ["open", "filed", "adopted", "declined"] as const;

type Layer = (typeof LAYERS)[number];

interface FixtureSetRow {
  id: string;
  name: string;
  host_id: string | null;
  root_path: string;
  manifest_hash: string;
  file_count: number;
  sealed_at: string;
  holdout: number;
}

interface RunRow {
  id: string;
  fixture_set_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  context_version: string | null;
  manifest_hash_at_run: string | null;
  refusal_reason: string | null;
  notes: string | null;
}

interface ScoreRow {
  run_id: string;
  scenario: string;
  layer: string;
  passed: number;
  score: number | null;
  judge_provider: string | null;
  judge_model: string | null;
  judge_tier: string | null;
  presentation_index: number | null;
  detail: string | null;
}

interface ProposalRow {
  id: string;
  run_id: string;
  scenario: string;
  traced_failure: string;
  evidence: string | null;
  amendment: string;
  target_path: string | null;
  task_key: string | null;
  status: string;
  created_at: string;
  feedback_note: string | null;
  decided_at: string | null;
  prediction: string | null;
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

export const rpcContract = defineRpcContract({
  listFixtureSets: {
    input: z.null(),
    output: z.object({
      sets: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          rootPath: z.string(),
          hostId: z.string().nullable(),
          fileCount: z.number(),
          sealedAt: z.string(),
          holdout: z.boolean(),
        }),
      ),
    }),
  },
  listRuns: {
    input: z.object({ limit: z.number().int().min(1).max(200).default(25) }).strict(),
    output: z.object({
      runs: z.array(
        z.object({
          id: z.string(),
          fixtureSetId: z.string(),
          startedAt: z.string(),
          finishedAt: z.string().nullable(),
          status: z.string(),
          contextVersion: z.string().nullable(),
          passRate: z.number().nullable(),
          scenarioCount: z.number(),
          deterministicPassRate: z.number().nullable(),
          judgePassRate: z.number().nullable(),
          refusalReason: z.string().nullable(),
        }),
      ),
    }),
  },
  trend: {
    input: z.object({ fixtureSetId: z.string() }).strict(),
    output: z.object({
      points: z.array(
        z.object({
          runId: z.string(),
          at: z.string(),
          contextVersion: z.string().nullable(),
          deterministicPassRate: z.number().nullable(),
          judgePassRate: z.number().nullable(),
        }),
      ),
    }),
  },
  listProposals: {
    input: z.object({ status: z.string().optional() }).strict(),
    output: z.object({
      proposals: z.array(
        z.object({
          id: z.string(),
          runId: z.string(),
          scenario: z.string(),
          tracedFailure: z.string(),
          amendment: z.string(),
          targetPath: z.string().nullable(),
          taskKey: z.string().nullable(),
          status: z.string(),
          createdAt: z.string(),
          evidence: z.string().nullable(),
          feedbackNote: z.string().nullable(),
          decidedAt: z.string().nullable(),
          prediction: z.string().nullable(),
        }),
      ),
    }),
  },
  updateProposalStatus: {
    input: z
      .object({
        id: z.string(),
        status: z.enum(["adopted", "declined"]),
        note: z.string().min(1),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  verifyFixtureSet: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({
      id: z.string(),
      name: z.string(),
      drifted: z.boolean(),
      reason: z.string().nullable(),
    }),
  },
  trendOverview: {
    input: z.null(),
    output: z.object({
      sets: z.array(
        z.object({
          fixtureSetId: z.string(),
          name: z.string(),
          holdout: z.boolean(),
          points: z.array(
            z.object({
              runId: z.string(),
              at: z.string(),
              contextVersion: z.string().nullable(),
              deterministicPassRate: z.number().nullable(),
              judgePassRate: z.number().nullable(),
            }),
          ),
        }),
      ),
    }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    taskProject: {
      type: "string",
      label: "Tasks project prefix",
      default: "EVL",
    },
    scheduleCron: {
      type: "string",
      label: "Ratchet cadence (5-field cron, server-local)",
      default: "0 9 * * 1",
    },
    scheduleEnabled: {
      type: "boolean",
      label: "Run the ratchet on a schedule",
      default: false,
    },
    judgeProviders: {
      type: "string",
      label: "Judge providers, comma-separated (cross-provider independence)",
      default: "claude-code,codex",
    },
    refuseOnDrift: {
      type: "boolean",
      label: "Refuse to score when the fixture manifest has drifted",
      default: true,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS fixture_sets (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL UNIQUE,
       host_id TEXT,
       root_path TEXT NOT NULL,
       manifest_hash TEXT NOT NULL,
       file_count INTEGER NOT NULL DEFAULT 0,
       sealed_at TEXT NOT NULL,
       holdout INTEGER NOT NULL DEFAULT 0
     )`,
    `CREATE TABLE IF NOT EXISTS runs (
       id TEXT PRIMARY KEY,
       fixture_set_id TEXT NOT NULL,
       started_at TEXT NOT NULL,
       finished_at TEXT,
       status TEXT NOT NULL,
       context_version TEXT,
       manifest_hash_at_run TEXT,
       refusal_reason TEXT,
       notes TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS scores (
       run_id TEXT NOT NULL,
       scenario TEXT NOT NULL,
       layer TEXT NOT NULL,
       passed INTEGER NOT NULL,
       score REAL,
       judge_provider TEXT,
       judge_model TEXT,
       judge_tier TEXT,
       presentation_index INTEGER,
       detail TEXT,
       PRIMARY KEY (run_id, scenario, layer, judge_provider)
     )`,
    `CREATE TABLE IF NOT EXISTS proposals (
       id TEXT PRIMARY KEY,
       run_id TEXT NOT NULL,
       scenario TEXT NOT NULL,
       traced_failure TEXT NOT NULL,
       evidence TEXT,
       amendment TEXT NOT NULL,
       target_path TEXT,
       task_key TEXT,
       status TEXT NOT NULL DEFAULT 'open',
       created_at TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_scores_run ON scores(run_id)`,
    `CREATE INDEX IF NOT EXISTS idx_runs_set ON runs(fixture_set_id, started_at)`,
    `ALTER TABLE proposals ADD COLUMN feedback_note TEXT`,
    `ALTER TABLE proposals ADD COLUMN decided_at TEXT`,
    `ALTER TABLE proposals ADD COLUMN prediction TEXT`,
  ]);

  const now = () => new Date().toISOString();
  const newId = (prefix: string) =>
    `${prefix}_${createHash("sha256")
      .update(`${Date.now()}:${Math.random()}`)
      .digest("hex")
      .slice(0, 12)}`;
  async function resolveHostId(ctx: { threadId?: string }, explicitHostId?: string) {
    if (explicitHostId) return explicitHostId;
    if (!ctx.threadId) return undefined;
    const thread = (await bb.sdk.threads.get({ threadId: ctx.threadId })) as { environmentId: string | null };
    if (!thread.environmentId) return undefined;
    const environment = (await bb.sdk.environments.get({ environmentId: thread.environmentId })) as { hostId: string };
    return environment.hostId;
  }

  // -------------------------------------------------------------------------
  // fixture sealing — the anti-reward-hacking primitive
  // -------------------------------------------------------------------------

  /**
   * Hash every file under the fixture root, sorted by path, content-addressed.
   * Uses bb.sdk.files so a fixture set can live on any enrolled machine — the
   * plugin runs on the server but fixtures may not.
   */
  async function computeManifest(
    rootPath: string,
    hostId: string | null,
  ): Promise<{ hash: string; fileCount: number }> {
    const listing = await bb.sdk.files.listPaths({
      ...(hostId ? { hostId } : {}),
      path: rootPath,
      includeFiles: true,
      includeDirectories: false,
    });
    const relPaths = (listing.paths ?? [])
      .map((entry: { path: string }) => entry.path)
      .sort((a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0));

    const digest = createHash("sha256");
    for (const rel of relPaths) {
      const abs = `${rootPath.replace(/\/$/, "")}/${rel}`;
      const file = await bb.sdk.files.read({
        ...(hostId ? { hostId } : {}),
        path: abs,
      });
      // Hash the path AND the content sha, so a rename is drift too.
      digest.update(rel);
      digest.update("\0");
      digest.update(file.sha256 ?? createHash("sha256").update(file.content ?? "").digest("hex"));
      digest.update("\n");
    }
    return { hash: digest.digest("hex"), fileCount: relPaths.length };
  }

  function getFixtureSet(nameOrId: string): FixtureSetRow | undefined {
    return db
      .prepare(`SELECT * FROM fixture_sets WHERE id = ? OR name = ?`)
      .get(nameOrId, nameOrId) as FixtureSetRow | undefined;
  }

  async function sealFixtureSet(opts: {
    name: string;
    rootPath: string;
    hostId: string | null;
    holdout: boolean;
  }) {
    const { hash, fileCount } = await computeManifest(opts.rootPath, opts.hostId);
    const existing = getFixtureSet(opts.name);
    const id = existing?.id ?? newId("fx");
    db.prepare(
      `INSERT INTO fixture_sets (id, name, host_id, root_path, manifest_hash, file_count, sealed_at, holdout)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         host_id = excluded.host_id,
         root_path = excluded.root_path,
         manifest_hash = excluded.manifest_hash,
         file_count = excluded.file_count,
         sealed_at = excluded.sealed_at,
         holdout = excluded.holdout`,
    ).run(
      id,
      opts.name,
      opts.hostId,
      opts.rootPath,
      hash,
      fileCount,
      now(),
      opts.holdout ? 1 : 0,
    );
    return { id, hash, fileCount };
  }

  /** Returns null when sealed and unchanged; a reason string when drifted. */
  async function checkDrift(set: FixtureSetRow): Promise<string | null> {
    const { hash, fileCount } = await computeManifest(set.root_path, set.host_id);
    if (hash === set.manifest_hash) return null;
    return `fixture manifest drift: sealed ${set.manifest_hash.slice(0, 12)} (${set.file_count} files) but computed ${hash.slice(0, 12)} (${fileCount} files). Re-seal deliberately with \`bb evals seal ${set.name} --path ${set.root_path}\` if the change is intended.`;
  }

  // -------------------------------------------------------------------------
  // runs and scoring
  // -------------------------------------------------------------------------

  async function startRun(opts: {
    fixtureSet: string;
    contextVersion?: string;
    notes?: string;
  }) {
    const set = getFixtureSet(opts.fixtureSet);
    if (!set) throw new Error(`unknown fixture set: ${opts.fixtureSet}`);

    const cfg = await settings.get();
    const runId = newId("run");
    const drift = await checkDrift(set);

    if (drift && cfg.refuseOnDrift) {
      db.prepare(
        `INSERT INTO runs (id, fixture_set_id, started_at, finished_at, status, context_version, manifest_hash_at_run, refusal_reason, notes)
         VALUES (?, ?, ?, ?, 'refused', ?, ?, ?, ?)`,
      ).run(
        runId,
        set.id,
        now(),
        now(),
        opts.contextVersion ?? null,
        set.manifest_hash,
        drift,
        opts.notes ?? null,
      );
      bb.realtime.publish("runs-changed", { runId });
      return { runId, refused: true as const, reason: drift };
    }

    db.prepare(
      `INSERT INTO runs (id, fixture_set_id, started_at, status, context_version, manifest_hash_at_run, notes)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`,
    ).run(
      runId,
      set.id,
      now(),
      opts.contextVersion ?? null,
      set.manifest_hash,
      opts.notes ?? null,
    );
    bb.realtime.publish("runs-changed", { runId });
    return { runId, refused: false as const, reason: drift };
  }

  function recordScore(opts: {
    runId: string;
    scenario: string;
    layer: Layer;
    passed: boolean;
    score?: number;
    judgeProvider?: string;
    judgeModel?: string;
    judgeTier?: string;
    presentationIndex?: number;
    detail?: string;
  }) {
    db.prepare(
      `INSERT OR REPLACE INTO scores
         (run_id, scenario, layer, passed, score, judge_provider, judge_model, judge_tier, presentation_index, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.runId,
      opts.scenario,
      opts.layer,
      opts.passed ? 1 : 0,
      opts.score ?? null,
      opts.judgeProvider ?? "",
      opts.judgeModel ?? null,
      opts.judgeTier ?? null,
      opts.presentationIndex ?? null,
      opts.detail ?? null,
    );
    bb.realtime.publish("runs-changed", { runId: opts.runId });
  }

  function finishRun(runId: string, status: "complete" | "failed", notes?: string) {
    db.prepare(
      `UPDATE runs SET finished_at = ?, status = ?, notes = COALESCE(?, notes) WHERE id = ?`,
    ).run(now(), status, notes ?? null, runId);
    bb.realtime.publish("runs-changed", { runId });
  }

  function runPassRates(runId: string) {
    const row = db
      .prepare(
        `SELECT
           SUM(CASE WHEN layer='deterministic' THEN 1 ELSE 0 END) AS det_total,
           SUM(CASE WHEN layer='deterministic' AND passed=1 THEN 1 ELSE 0 END) AS det_pass,
           SUM(CASE WHEN layer='judge' THEN 1 ELSE 0 END) AS jud_total,
           SUM(CASE WHEN layer='judge' AND passed=1 THEN 1 ELSE 0 END) AS jud_pass
         FROM scores WHERE run_id = ?`,
      )
      .get(runId) as Record<string, number | null>;
    const rate = (pass: number | null, total: number | null) =>
      total && total > 0 ? Number(((pass ?? 0) / total).toFixed(4)) : null;
    return {
      deterministic: rate(row.det_pass, row.det_total),
      judge: rate(row.jud_pass, row.jud_total),
      scenarioCount: (row.det_total ?? 0) + (row.jud_total ?? 0),
    };
  }

  function percentText(rate: number | null) {
    return rate === null ? "—" : `${Math.round(rate * 100)}%`;
  }

  // -------------------------------------------------------------------------
  // proposals — created here, NEVER applied here
  // -------------------------------------------------------------------------

  function createProposal(opts: {
    runId: string;
    scenario: string;
    tracedFailure: string;
    evidence?: string;
    amendment: string;
    targetPath?: string;
    prediction?: string;
  }) {
    const id = newId("prop");
    db.prepare(
      `INSERT INTO proposals (id, run_id, scenario, traced_failure, evidence, amendment, target_path, status, created_at, prediction)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).run(
      id,
      opts.runId,
      opts.scenario,
      opts.tracedFailure,
      opts.evidence ?? null,
      opts.amendment,
      opts.targetPath ?? null,
      now(),
      opts.prediction ?? null,
    );
    bb.realtime.publish("proposals-changed", { proposalId: id });
    return id;
  }

  function decideProposal(proposalId: string, status: "adopted" | "declined", note: string) {
    if (!note.trim()) throw new Error("--note is required");
    const result = db
      .prepare(`UPDATE proposals SET status = ?, feedback_note = ?, decided_at = ? WHERE id = ?`)
      .run(status, note, now(), proposalId);
    if (result.changes === 0) throw new Error(`unknown proposal: ${proposalId}`);
    bb.realtime.publish("proposals-changed", { proposalId });
  }

  /**
   * File an open proposal into the tasks plugin. Shelling out to the bb CLI is
   * deliberate: tasks is a sibling plugin with no SDK surface, and this runs
   * server-local where `bb` is on PATH.
   */
  async function fileProposalAsTask(proposalId: string): Promise<string | null> {
    const cfg = await settings.get();
    const p = db
      .prepare(`SELECT * FROM proposals WHERE id = ?`)
      .get(proposalId) as Record<string, string> | undefined;
    if (!p) throw new Error(`unknown proposal: ${proposalId}`);
    if (p.task_key) return p.task_key;

    const body = [
      `**Traced failure** (judge's own words)`,
      ``,
      `> ${p.traced_failure.replace(/\n/g, "\n> ")}`,
      ``,
      `**Evidence**`,
      ``,
      p.evidence ?? "_none recorded_",
      ``,
      `**Proposed control-plane amendment**`,
      ``,
      p.amendment,
      ``,
      p.target_path ? `**Target:** \`${p.target_path}\`` : "",
      ``,
      `---`,
      `**Human review required.** This is a draft amendment, not a patch. The evals plugin has no apply operation — adoption means you editing the target document yourself. Revise it if it is close but not right.`,
      ``,
      `Run: \`${p.run_id}\` · Scenario: \`${p.scenario}\` · Proposal: \`${p.id}\``,
    ].join("\n");

    try {
      const { stdout } = await execFileAsync(
        "bb",
        [
          "tasks",
          "create",
          "--project",
          cfg.taskProject,
          "--title",
          `Eval proposal: ${p.scenario}`,
          "--description",
          body,
          "--json",
        ],
        { maxBuffer: 8 * 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout) as { task?: { key?: string } };
      const key = parsed.task?.key ?? null;
      if (key) {
        db.prepare(`UPDATE proposals SET task_key = ?, status = 'filed' WHERE id = ?`).run(
          key,
          proposalId,
        );
        bb.realtime.publish("proposals-changed", { proposalId });
      }
      return key;
    } catch (error) {
      bb.log.error(`failed to file proposal ${proposalId} as a task: ${String(error)}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // rpc
  // -------------------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    listFixtureSets() {
      const rows = db.prepare(`SELECT * FROM fixture_sets ORDER BY name`).all() as FixtureSetRow[];
      return {
        sets: rows.map((r) => ({
          id: r.id,
          name: r.name,
          rootPath: r.root_path,
          hostId: r.host_id,
          fileCount: r.file_count,
          sealedAt: r.sealed_at,
          holdout: r.holdout === 1,
        })),
      };
    },
    listRuns({ limit }) {
      const rows = db
        .prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`)
        .all(limit) as RunRow[];
      return {
        runs: rows.map((r) => {
          const rates = runPassRates(r.id);
          return {
            id: r.id,
            fixtureSetId: r.fixture_set_id,
            startedAt: r.started_at,
            finishedAt: r.finished_at,
            status: r.status,
            contextVersion: r.context_version,
            passRate: rates.judge ?? rates.deterministic,
            scenarioCount: rates.scenarioCount,
            deterministicPassRate: rates.deterministic,
            judgePassRate: rates.judge,
            refusalReason: r.refusal_reason,
          };
        }),
      };
    },
    trend({ fixtureSetId }) {
      const rows = db
        .prepare(
          `SELECT * FROM runs WHERE fixture_set_id = ? AND status = 'complete' ORDER BY started_at ASC`,
        )
        .all(fixtureSetId) as RunRow[];
      return {
        points: rows.map((r) => {
          const rates = runPassRates(r.id);
          return {
            runId: r.id,
            at: r.started_at,
            contextVersion: r.context_version,
            deterministicPassRate: rates.deterministic,
            judgePassRate: rates.judge,
          };
        }),
      };
    },
    listProposals({ status }) {
      const rows = (
        status
          ? db.prepare(`SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC`).all(status)
          : db.prepare(`SELECT * FROM proposals ORDER BY created_at DESC`).all()
      ) as ProposalRow[];
      return {
        proposals: rows.map((r) => ({
          id: r.id,
          runId: r.run_id,
          scenario: r.scenario,
          tracedFailure: r.traced_failure,
          amendment: r.amendment,
          targetPath: r.target_path ?? null,
          taskKey: r.task_key ?? null,
          status: r.status,
          createdAt: r.created_at,
          evidence: r.evidence ?? null,
          feedbackNote: r.feedback_note ?? null,
          decidedAt: r.decided_at ?? null,
          prediction: r.prediction ?? null,
        })),
      };
    },
    updateProposalStatus({ id, status, note }) {
      decideProposal(id, status, note);
      return { ok: true as const };
    },
    async verifyFixtureSet({ id }) {
      const set = getFixtureSet(id);
      if (!set) throw new Error(`unknown fixture set: ${id}`);
      const reason = await checkDrift(set);
      return { id: set.id, name: set.name, drifted: reason !== null, reason };
    },
    trendOverview() {
      const sets = db.prepare(`SELECT * FROM fixture_sets ORDER BY holdout, name`).all() as FixtureSetRow[];
      return {
        sets: sets.map((set) => {
          const rows = db
            .prepare(`SELECT * FROM runs WHERE fixture_set_id = ? AND status = 'complete' ORDER BY started_at ASC`)
            .all(set.id) as RunRow[];
          return {
            fixtureSetId: set.id,
            name: set.name,
            holdout: set.holdout === 1,
            points: rows.map((r) => {
              const rates = runPassRates(r.id);
              return {
                runId: r.id,
                at: r.started_at,
                contextVersion: r.context_version,
                deterministicPassRate: rates.deterministic,
                judgePassRate: rates.judge,
              };
            }),
          };
        }),
      };
    },
  });

  // -------------------------------------------------------------------------
  // agent tool — the knowledge-base context feeder
  // -------------------------------------------------------------------------

  bb.agents.registerTool({
    name: "evals_state",
    description:
      "Read the eval ratchet's current state: sealed fixture sets, recent run pass rates, and open proposals awaiting human review. Use before amending an AGENTS.md or a definition of done, so you know what the ratchet has already flagged.",
    instructions:
      "The eval ratchet records whether context changes actually improved agent output. Before proposing changes to conventions or instruction files, call evals_state to see open proposals and recent trend.",
    experimental_statusLabels: {
      pending: "Reading eval ratchet state",
      completed: "Read eval ratchet state",
    },
    parameters: z.object({
      include: z
        .enum(["all", "proposals", "trend", "fixtures"])
        .default("all")
        .describe("Which slice of eval state to return."),
    }),
    async execute({ include }) {
      const parts: string[] = [];
      if (include === "all" || include === "fixtures") {
        const sets = db.prepare(`SELECT * FROM fixture_sets ORDER BY name`).all() as FixtureSetRow[];
        parts.push(
          `## Sealed fixture sets (${sets.length})\n` +
            (sets.length
              ? sets
                  .map(
                    (s) =>
                      `- **${s.name}**${s.holdout ? " _(holdout — never proposed against)_" : ""}: ${s.file_count} files, sealed ${s.sealed_at}, hash \`${s.manifest_hash.slice(0, 12)}\``,
                  )
                  .join("\n")
              : "_none sealed yet_"),
        );
      }
      if (include === "all" || include === "trend") {
        const runs = db
          .prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT 10`)
          .all() as RunRow[];
        parts.push(
          `## Recent runs (${runs.length})\n` +
            (runs.length
              ? runs
                  .map((r) => {
                    const rates = runPassRates(r.id);
                    const det = rates.deterministic === null ? "—" : `${Math.round(rates.deterministic * 100)}%`;
                    const jud = rates.judge === null ? "—" : `${Math.round(rates.judge * 100)}%`;
                    const suffix = r.status === "refused" ? ` REFUSED: ${r.refusal_reason}` : "";
                    return `- \`${r.id}\` ${r.started_at} · ${r.status} · deterministic ${det} · judge ${jud}${suffix}`;
                  })
                  .join("\n")
              : "_no runs yet_"),
        );
      }
      if (include === "all" || include === "proposals") {
        const props = db
          .prepare(`SELECT * FROM proposals WHERE status IN ('open','filed') ORDER BY created_at DESC LIMIT 20`)
          .all() as Record<string, string>[];
        parts.push(
          `## Open proposals (${props.length})\n` +
            (props.length
              ? props
                  .map(
                    (p) =>
                      `- \`${p.id}\`${p.task_key ? ` (${p.task_key})` : ""} **${p.scenario}** — ${p.traced_failure.slice(0, 160)}${p.traced_failure.length > 160 ? "…" : ""}`,
                  )
                  .join("\n")
              : "_none open_"),
        );
        parts.push(
          `\n> Proposals are never self-applied. This plugin has no apply operation; a human copies an amendment into the target document.`,
        );
      }
      return parts.join("\n\n");
    },
  });

  bb.agents.configure(() => ({ tools: ["evals_state"], skills: ["eval-ratchet"] }));

  bb.agents.contributeInstructions(() => {
    try {
      const open = db
        .prepare(`SELECT COUNT(*) AS n FROM proposals WHERE status IN ('open','filed')`)
        .get() as { n: number };
      const refused = db
        .prepare(
          `SELECT COUNT(*) AS n FROM runs WHERE status = 'refused' AND started_at > datetime('now','-14 days')`,
        )
        .get() as { n: number };
      if (!open.n && !refused.n) return null;
      const lines: string[] = [];
      if (open.n) {
        lines.push(
          `The eval ratchet has ${open.n} open proposal${open.n === 1 ? "" : "s"} awaiting human review. Call \`evals_state\` before amending any AGENTS.md or definition of done. Never apply a proposal yourself.`,
        );
      }
      if (refused.n) {
        lines.push(
          `${refused.n} recent eval run${refused.n === 1 ? "" : "s"} REFUSED to score because the sealed fixture manifest drifted. Scores are not trustworthy until the fixtures are deliberately re-sealed.`,
        );
      }
      return lines.join(" ");
    } catch {
      return null;
    }
  });

  // -------------------------------------------------------------------------
  // cli
  // -------------------------------------------------------------------------

  bb.cli.register({
    name: "evals",
    summary: "The eval ratchet: sealed fixtures, scored runs, and human-gated proposals",
    commands: [
      { name: "fixtures", summary: "List sealed fixture sets", usage: "bb evals fixtures" },
      {
        name: "seal",
        summary: "Seal (or re-seal) a fixture set by hashing its contents",
        usage: "bb evals seal <name> --path <dir> [--host <hostId>] [--holdout]",
      },
      {
        name: "verify",
        summary: "Check a sealed fixture set for drift without running anything",
        usage: "bb evals verify <name>",
      },
      {
        name: "check",
        summary: "Run Meadow's deterministic knowledge-base session checks natively",
        usage: "bb evals check <kb-root> [--range <a>..<b>] [--run <run-id>] [--host <hostId>]",
      },
      {
        name: "start",
        summary: "Open a run; refuses if fixtures drifted",
        usage: "bb evals start <fixture-set> [--context-version <v>] [--notes <text>]",
      },
      {
        name: "score",
        summary: "Record one scenario score into an open run",
        usage:
          "bb evals score <run-id> --scenario <name> --layer deterministic|judge --passed true|false [--judge-provider <id>] [--judge-model <m>] [--tier <t>] [--position <n>] [--detail <text>]",
      },
      {
        name: "finish",
        summary: "Close a run",
        usage: "bb evals finish <run-id> [--status complete|failed]",
      },
      { name: "runs", summary: "List recent runs with pass rates", usage: "bb evals runs [--limit N]" },
      { name: "trend", summary: "Show pass-rate trend for a fixture set", usage: "bb evals trend <fixture-set>" },
      {
        name: "propose",
        summary: "Record a traced-failure proposal (never applied automatically)",
        usage:
          "bb evals propose <run-id> --scenario <name> --failure <text> --amendment <text> [--evidence <text>] [--target <path>] [--prediction <text>]",
      },
      { name: "proposals", summary: "List proposals", usage: "bb evals proposals [--status open|filed|adopted|declined]" },
      { name: "file", summary: "File an open proposal into the tasks plugin", usage: "bb evals file <proposal-id>" },
      { name: "adopt", summary: "Mark a proposal adopted without applying it", usage: "bb evals adopt <proposal-id> --note <text>" },
      { name: "decline", summary: "Mark a proposal declined without applying it", usage: "bb evals decline <proposal-id> --note <text>" },
      { name: "status", summary: "Plugin status and configuration", usage: "bb evals status" },
    ],
    async run(argv, ctx) {
      const flag = (name: string): string | undefined => {
        const i = argv.indexOf(`--${name}`);
        return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
      };
      const has = (name: string) => argv.includes(`--${name}`);
      const json = has("json");
      const ok = (text: string, data?: unknown) => ({
        exitCode: 0,
        stdout: json && data !== undefined ? JSON.stringify(data, null, 2) : text,
      });
      const err = (text: string) => ({ exitCode: 1, stderr: text });

      const [a, b, ...rest] = argv;
      void rest;

      try {
        if (a === "status") {
          const cfg = await settings.get();
          const sets = db.prepare(`SELECT COUNT(*) n FROM fixture_sets`).get() as { n: number };
          const runs = db.prepare(`SELECT COUNT(*) n FROM runs`).get() as { n: number };
          const open = db
            .prepare(`SELECT COUNT(*) n FROM proposals WHERE status IN ('open','filed')`)
            .get() as { n: number };
          return ok(
            [
              `evals — the eval ratchet`,
              `  fixture sets:    ${sets.n}`,
              `  runs recorded:   ${runs.n}`,
              `  open proposals:  ${open.n}`,
              `  tasks project:   ${cfg.taskProject}`,
              `  schedule:        ${cfg.scheduleEnabled ? cfg.scheduleCron : "disabled"}`,
              `  judges:          ${cfg.judgeProviders}`,
              `  refuse on drift: ${cfg.refuseOnDrift}`,
            ].join("\n"),
            { sets: sets.n, runs: runs.n, openProposals: open.n, ...cfg },
          );
        }

        if (a === "fixtures") {
          const rows = db.prepare(`SELECT * FROM fixture_sets ORDER BY name`).all() as FixtureSetRow[];
          if (!rows.length) return ok("No fixture sets sealed yet.", { sets: [] });
          return ok(
            rows
              .map(
                (r) =>
                  `${r.name}${r.holdout ? "  [holdout]" : ""}\n  path:   ${r.root_path}${r.host_id ? ` (host ${r.host_id})` : ""}\n  files:  ${r.file_count}\n  hash:   ${r.manifest_hash.slice(0, 16)}\n  sealed: ${r.sealed_at}`,
              )
              .join("\n\n"),
            { sets: rows },
          );
        }

        if (a === "seal") {
          const name = b;
          const path = flag("path");
          if (!name || !path) return err("usage: bb evals seal <name> --path <dir> [--host <hostId>] [--holdout]");
          const result = await sealFixtureSet({
            name,
            rootPath: path,
            hostId: flag("host") ?? null,
            holdout: has("holdout"),
          });
          return ok(
            `Sealed "${name}": ${result.fileCount} files, hash ${result.hash.slice(0, 16)}`,
            result,
          );
        }

        if (a === "verify") {
          const set = getFixtureSet(b ?? "");
          if (!set) return err(`unknown fixture set: ${b}`);
          const drift = await checkDrift(set);
          if (!drift) return ok(`"${set.name}" is intact (${set.file_count} files).`, { drifted: false });
          return { exitCode: 2, stdout: json ? JSON.stringify({ drifted: true, reason: drift }) : `DRIFTED\n${drift}` };
        }

        if (a === "check") {
          const kbRoot = b ?? ctx.cwd;
          if (!kbRoot) return err("usage: bb evals check <kb-root> [--range <a>..<b>] [--run <run-id>]");
          const hostId = await resolveHostId(ctx, flag("host"));
          const summary = await runNativeSessionChecks(
            {
              async git(args) {
                const { stdout } = await execFileAsync("git", args, { cwd: kbRoot, maxBuffer: 16 * 1024 * 1024 });
                return stdout;
              },
              async readFileAtRef(path, ref) {
                if (ref !== "HEAD") {
                  throw new Error(
                    "bb evals check reads knowledge-base content through bb.sdk.files, which can only read the checked-out worktree. Use a range ending at HEAD.",
                  );
                }
                try {
                  const file = await bb.sdk.files.read({
                    ...(hostId ? { hostId } : {}),
                    path: `${kbRoot.replace(/\/$/, "")}/${path}`,
                    rootPath: kbRoot,
                  });
                  return file.content ?? null;
                } catch {
                  return null;
                }
              },
              hasStateStore: false,
            },
            flag("range"),
          );
          const runId = flag("run");
          if (runId) {
            for (const check of summary.checks) {
              recordScore({
                runId,
                scenario: check.id,
                layer: "deterministic",
                passed: !check.applicable || check.passed,
                score: !check.applicable || check.passed ? 1 : 0,
                detail: `${check.applicable ? "applicable" : "not applicable"}: ${check.detail}`,
              });
            }
          }
          const output = formatNativeCheckSummary(summary);
          const failures = summary.checks.filter((check) => check.applicable && !check.passed);
          return {
            exitCode: failures.length ? 1 : 0,
            stdout:
              json
                ? JSON.stringify({ ...summary, recordedRunId: runId ?? null }, null, 2)
                : runId
                  ? `${output}\nRecorded deterministic scores into ${runId}`
                  : output,
          };
        }

        if (a === "start") {
          const setName = b;
          if (!setName) return err("usage: bb evals start <fixture-set> [--context-version <v>]");
          const r = await startRun({
            fixtureSet: setName,
            contextVersion: flag("context-version"),
            notes: flag("notes"),
          });
          if (r.refused) {
            return {
              exitCode: 2,
              stdout: json ? JSON.stringify(r) : `REFUSED — run ${r.runId}\n${r.reason}`,
            };
          }
          return ok(`Run started: ${r.runId}`, r);
        }

        if (a === "score") {
          const runId = b;
          const scenario = flag("scenario");
          const layer = flag("layer") as Layer | undefined;
          const passedRaw = flag("passed");
          if (!runId || !scenario || !layer || passedRaw === undefined)
            return err("usage: bb evals score <run-id> --scenario <name> --layer deterministic|judge --passed true|false");
          if (!LAYERS.includes(layer)) return err(`--layer must be one of ${LAYERS.join("|")}`);
          recordScore({
            runId,
            scenario,
            layer,
            passed: passedRaw === "true" || passedRaw === "1",
            score: flag("score") ? Number(flag("score")) : undefined,
            judgeProvider: flag("judge-provider"),
            judgeModel: flag("judge-model"),
            judgeTier: flag("tier"),
            presentationIndex: flag("position") ? Number(flag("position")) : undefined,
            detail: flag("detail"),
          });
          return ok(`Recorded ${layer} score for "${scenario}" in ${runId}`);
        }

        if (a === "finish") {
          const runId = b;
          if (!runId) return err("usage: bb evals finish <run-id> [--status complete|failed]");
          const status = (flag("status") ?? "complete") as "complete" | "failed";
          finishRun(runId, status, flag("notes"));
          const rates = runPassRates(runId);
          return ok(
            `Run ${runId} ${status}. deterministic=${rates.deterministic ?? "—"} judge=${rates.judge ?? "—"} scenarios=${rates.scenarioCount}`,
            { runId, status, ...rates },
          );
        }

        if (a === "runs") {
          const limit = Number(flag("limit") ?? 20);
          const rows = db
            .prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`)
            .all(limit) as RunRow[];
          if (!rows.length) return ok("No runs recorded yet.", { runs: [] });
          return ok(
            rows
              .map((r) => {
                const rates = runPassRates(r.id);
                const det = rates.deterministic === null ? "—" : `${Math.round(rates.deterministic * 100)}%`;
                const jud = rates.judge === null ? "—" : `${Math.round(rates.judge * 100)}%`;
                return `${r.id}  ${r.started_at}  ${r.status.padEnd(9)}  det ${det.padStart(4)}  judge ${jud.padStart(4)}${r.refusal_reason ? `\n    ${r.refusal_reason}` : ""}`;
              })
              .join("\n"),
            { runs: rows },
          );
        }

        if (a === "trend") {
          const set = getFixtureSet(b ?? "");
          if (!set) return err(`unknown fixture set: ${b}`);
          const holdoutSets = db.prepare(`SELECT * FROM fixture_sets WHERE holdout = 1 ORDER BY name`).all() as FixtureSetRow[];
          const rows = db
            .prepare(`SELECT * FROM runs WHERE fixture_set_id = ? AND status='complete' ORDER BY started_at ASC`)
            .all(set.id) as RunRow[];
          if (!rows.length) return ok(`No completed runs for "${set.name}" yet.`, { points: [] });
          const lines = rows.map((r) => {
            const rates = runPassRates(r.id);
            const jud = rates.judge === null ? null : Math.round(rates.judge * 100);
            const bar = jud === null ? "" : "█".repeat(Math.round(jud / 5));
            return `${r.started_at.slice(0, 10)}  ${(r.context_version ?? "—").padEnd(14)}  ${String(jud ?? "—").padStart(3)}%  ${bar}`;
          });
          const holdoutLines = holdoutSets.flatMap((holdout) => {
            const holdoutRuns = db
              .prepare(`SELECT * FROM runs WHERE fixture_set_id = ? AND status='complete' ORDER BY started_at ASC`)
              .all(holdout.id) as RunRow[];
            if (!holdoutRuns.length) return [`${holdout.name}: no completed holdout runs`];
            const latest = holdoutRuns[holdoutRuns.length - 1];
            const rates = runPassRates(latest.id);
            return [`${holdout.name}: latest holdout judge ${percentText(rates.judge)} at ${(latest.context_version ?? "—")}`];
          });
          return ok(
            [
              `Judge pass-rate trend — ${set.name}${holdoutSets.length ? " (working set)" : ""}`,
              ...lines,
              ...(holdoutLines.length ? ["", "Holdout comparison", ...holdoutLines] : []),
            ].join("\n"),
            { points: rows, holdouts: holdoutSets },
          );
        }

        if (a === "propose") {
          const runId = b;
          const scenario = flag("scenario");
          const failure = flag("failure");
          const amendment = flag("amendment");
          if (!runId || !scenario || !failure || !amendment)
            return err("usage: bb evals propose <run-id> --scenario <name> --failure <text> --amendment <text>");
          const id = createProposal({
            runId,
            scenario,
            tracedFailure: failure,
            amendment,
            evidence: flag("evidence"),
            targetPath: flag("target"),
            prediction: flag("prediction"),
          });
          return ok(`Proposal recorded: ${id}\nFile it with: bb evals file ${id}`, { id });
        }

        if (a === "proposals") {
          const status = flag("status");
          const rows = (
            status
              ? db.prepare(`SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC`).all(status)
              : db.prepare(`SELECT * FROM proposals ORDER BY created_at DESC`).all()
          ) as Record<string, string>[];
          if (!rows.length) return ok("No proposals.", { proposals: [] });
          return ok(
            rows
              .map(
                (p) =>
                  `${p.id}  ${p.status.padEnd(8)}  ${p.task_key ?? "—".padEnd(7)}  ${p.scenario}\n    ${p.traced_failure.slice(0, 120)}`,
              )
              .join("\n"),
            { proposals: rows },
          );
        }

        if (a === "file") {
          if (!b) return err("usage: bb evals file <proposal-id>");
          const key = await fileProposalAsTask(b);
          if (!key) return err(`could not file ${b} as a task — see \`bb plugin logs evals\``);
          return ok(`Filed ${b} as ${key}`, { proposalId: b, taskKey: key });
        }

        if (a === "adopt" || a === "decline") {
          if (!b) return err(`usage: bb evals ${a} <proposal-id> --note <text>`);
          const note = flag("note");
          if (!note) return err(`usage: bb evals ${a} <proposal-id> --note <text>`);
          const status = a === "adopt" ? "adopted" : "declined";
          decideProposal(b, status, note);
          return ok(
            `${b} marked ${status}. No target document was changed; copy the amendment yourself if adopting.`,
            { proposalId: b, status },
          );
        }

        return err(
          "Unknown command. Try: bb evals status | fixtures | seal | verify | check | start | score | finish | runs | trend | propose | proposals | file | adopt | decline",
        );
      } catch (error) {
        return err(`evals: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  // -------------------------------------------------------------------------
  // schedule
  // -------------------------------------------------------------------------

  const cfg = await settings.get();
  if (cfg.scheduleEnabled) {
    bb.background.schedule("ratchet", cfg.scheduleCron, async () => {
      const sets = db
        .prepare(`SELECT * FROM fixture_sets WHERE holdout = 0 ORDER BY name`)
        .all() as FixtureSetRow[];
      if (!sets.length) {
        bb.log.info("ratchet tick: no non-holdout fixture sets sealed; nothing to do");
        return;
      }
      for (const set of sets) {
        const drift = await checkDrift(set);
        if (drift) {
          bb.log.warn(`ratchet tick: ${set.name} DRIFTED — ${drift}`);
        } else {
          bb.log.info(`ratchet tick: ${set.name} intact (${set.file_count} files)`);
        }
      }
      bb.realtime.publish("ratchet", { at: now() });
    });
  }

  bb.log.info("evals plugin loaded");
}
