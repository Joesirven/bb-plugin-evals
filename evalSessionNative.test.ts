import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  CHECK_NAMES,
  runNativeSessionChecks,
  type NativeCheckHost,
} from "./evalSessionNative";

const execFileAsync = promisify(execFile);
const bbCli = process.env.BB_CLI || "bb";
const bbEnv = { ...process.env };

async function runBb(args: string[]) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await execFileAsync(bbCli, args, { env: bbEnv });
    } catch (error) {
      lastError = error;
      const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";
      if (!stderr.includes("bb isn't running")) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

function fakeHost(opts: {
  commits?: string[];
  nameStatus?: string[][];
  files?: Record<string, string>;
  hasStateStore?: boolean;
  stateStoreHasSessionRow?: NativeCheckHost["stateStoreHasSessionRow"];
}): NativeCheckHost {
  return {
    async git(args) {
      if (args[0] === "log") return (opts.commits ?? ["abc123 ops: valid change [session: s1]"]).join("\n");
      if (args[0] === "diff") return (opts.nameStatus ?? []).map((row) => row.join("\t")).join("\n");
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    async readFileAtRef(path) {
      return opts.files?.[path] ?? null;
    },
    hasStateStore: opts.hasStateStore ?? false,
    stateStoreHasSessionRow: opts.stateStoreHasSessionRow,
  };
}

test("native session checks keep python-compatible names", async () => {
  const result = await runNativeSessionChecks(fakeHost({ nameStatus: [["M", "00-OPS/AGENTS-LOG.md"]] }), "A..B");
  assert.deepEqual(result.checks.map((check) => check.id), [...CHECK_NAMES]);
});

test("C1 commit format fails malformed subjects", async () => {
  const result = await runNativeSessionChecks(
    fakeHost({ commits: ["abc123 missing session tag"], nameStatus: [["M", "00-OPS/AGENTS-LOG.md"]] }),
    "A..B",
  );
  assert.equal(result.checks.find((check) => check.id === "C1-commit-format")?.passed, false);
});

test("C2 frontmatter requires the shared required fields", async () => {
  const result = await runNativeSessionChecks(
    fakeHost({
      nameStatus: [["M", "05-RESEARCH/card.md"], ["M", "00-OPS/AGENTS-LOG.md"]],
      files: { "05-RESEARCH/card.md": "---\ntitle: Card\ntype: research\nstatus: active\n---\n" },
    }),
    "A..B",
  );
  assert.equal(result.checks.find((check) => check.id === "C2-frontmatter")?.passed, false);
});

test("C3 requires the agents log row", async () => {
  const result = await runNativeSessionChecks(fakeHost({ nameStatus: [["M", "README.md"]] }), "A..B");
  assert.equal(result.checks.find((check) => check.id === "C3-agents-log-row")?.passed, false);
});

test("C4 is applicable only with a configured state store", async () => {
  const result = await runNativeSessionChecks(
    fakeHost({
      hasStateStore: true,
      stateStoreHasSessionRow: async () => true,
      nameStatus: [["M", "00-OPS/AGENTS-LOG.md"]],
    }),
    "A..B",
  );
  assert.equal(result.checks.find((check) => check.id === "C4-agent-state")?.applicable, true);
  assert.equal(result.checks.find((check) => check.id === "C4-agent-state")?.passed, true);
});

test("C5 requires an index update when markdown files are added", async () => {
  const result = await runNativeSessionChecks(fakeHost({ nameStatus: [["A", "05-RESEARCH/new.md"]] }), "A..B");
  assert.equal(result.checks.find((check) => check.id === "C5-index-updated")?.passed, false);
});

test("C6 research documents require citation, url, and topic_cluster", async () => {
  const result = await runNativeSessionChecks(
    fakeHost({
      nameStatus: [["M", "05-RESEARCH/card.md"], ["M", "00-OPS/AGENTS-LOG.md"]],
      files: { "05-RESEARCH/card.md": "---\ntitle: Card\ntype: research\nstatus: active\nupdated: 2026-08-07\nurl: https://example.com\n---\n" },
    }),
    "A..B",
  );
  assert.equal(result.checks.find((check) => check.id === "C6-research-dod")?.passed, false);
});

test("C7 library documents require metadata and a topic index", async () => {
  const result = await runNativeSessionChecks(
    fakeHost({
      nameStatus: [["M", "07-LIBRARY/topic/card.md"], ["M", "00-OPS/AGENTS-LOG.md"]],
      files: { "07-LIBRARY/topic/card.md": "---\ntitle: Card\ntype: library\nstatus: active\nupdated: 2026-08-07\nurl: https://example.com\n---\n" },
    }),
    "A..B",
  );
  assert.equal(result.checks.find((check) => check.id === "C7-library-dod")?.passed, false);
});

test("C8 locked architecture documents require an architecture decision record", async () => {
  const result = await runNativeSessionChecks(
    fakeHost({
      nameStatus: [["M", "01-ARCHITECTURE/system.md"], ["M", "00-OPS/AGENTS-LOG.md"]],
      files: { "01-ARCHITECTURE/system.md": "---\ntitle: System\ntype: architecture\nstatus: locked\nupdated: 2026-08-07\n---\n" },
    }),
    "A..B",
  );
  assert.equal(result.checks.find((check) => check.id === "C8-locked-needs-adr")?.passed, false);
});

test("C9 data documents require pii and license_terms", async () => {
  const result = await runNativeSessionChecks(
    fakeHost({
      nameStatus: [["M", "data.md"], ["M", "00-OPS/AGENTS-LOG.md"]],
      files: { "data.md": "---\ntitle: Data\ntype: data\nstatus: active\nupdated: 2026-08-07\n---\n" },
    }),
    "A..B",
  );
  assert.equal(result.checks.find((check) => check.id === "C9-data-dod")?.passed, false);
});

test("proposal adopt and decline are status-only and do not apply amendments", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "evals-proposal-"));
  const target = join(scratch, "AGENTS.md");
  await writeFile(target, "original\n", "utf8");

  const proposed = await runBb([
    "evals",
    "propose",
    "run_test",
    "--scenario",
    `test-${Date.now()}`,
    "--failure",
    "failure",
    "--amendment",
    "amendment that must not be applied",
    "--target",
    target,
    "--json",
  ]);
  const proposalId = JSON.parse(proposed.stdout).id as string;
  await runBb(["evals", "adopt", proposalId, "--note", "accepted for test"]);
  assert.equal(await readFile(target, "utf8"), "original\n");

  const declined = await runBb([
    "evals",
    "propose",
    "run_test",
    "--scenario",
    `test-decline-${Date.now()}`,
    "--failure",
    "failure",
    "--amendment",
    "another amendment that must not be applied",
    "--target",
    target,
    "--json",
  ]);
  const declinedId = JSON.parse(declined.stdout).id as string;
  await runBb(["evals", "decline", declinedId, "--note", "rejected for test"]);
  assert.equal(await readFile(target, "utf8"), "original\n");
});
