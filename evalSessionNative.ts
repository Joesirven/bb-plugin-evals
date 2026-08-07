import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CHECK_NAMES = [
  "C1-commit-format",
  "C2-frontmatter",
  "C3-agents-log-row",
  "C4-agent-state",
  "C5-index-updated",
  "C6-research-dod",
  "C7-library-dod",
  "C8-locked-needs-adr",
  "C9-data-dod",
] as const;

export type CheckName = (typeof CHECK_NAMES)[number];

export interface NativeCheckResult {
  id: CheckName;
  applicable: boolean;
  passed: boolean;
  detail: string;
}

export interface NativeCheckSummary {
  range: string;
  commitCount: number;
  touchedCount: number;
  sessions: string[];
  checks: NativeCheckResult[];
  passedApplicable: number;
  applicableCount: number;
}

export interface NativeCheckHost {
  git(args: string[]): Promise<string>;
  readFileAtRef(path: string, ref: string): Promise<string | null>;
  hasStateStore?: boolean;
  stateStoreHasSessionRow?: (sessions: string[]) => Promise<boolean | "unreachable">;
}

const FM_REQ = ["title", "type", "status", "updated"] as const;
const FM_SKIP = [
  "08-ARCHIVE/",
  "site/",
  ".obsidian/",
  "_tools/",
  "-TEMPLATE.md",
  "AGENTS.md",
  "agents.md",
  "README.md",
] as const;
const COMMIT_RE = /^[\w+./-]+: .+ \[session: .+\]$/;

function parseFrontmatter(text: string | null): Record<string, string> | null {
  if (text === null) return null;
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const field = line.match(/^(\w+):\s*(.*)$/);
    if (field) result[field[1]] = field[2];
  }
  return result;
}

function isFrontmatterSkipped(path: string): boolean {
  return FM_SKIP.some((needle) => path.includes(needle));
}

export function parseRange(input: string | undefined): { range: string; start: string; end: string } {
  const range = input ?? "HEAD~1..HEAD";
  const parts = range.split("..");
  if (parts.length !== 2) {
    throw new Error(`eval: could not parse commit range '${range}' (expected the form <A>..<B>)`);
  }
  return { range, start: parts[0], end: parts[1] || "HEAD" };
}

export async function runNativeSessionChecks(
  host: NativeCheckHost,
  rangeInput?: string,
): Promise<NativeCheckSummary> {
  const { range, end } = parseRange(rangeInput);
  let commits: string[];
  let nameStatus: string[][];
  try {
    commits = (await host.git(["log", "--format=%h %s", range])).split("\n").filter(Boolean);
    nameStatus = (await host.git(["diff", "--name-status", range]))
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"));
  } catch {
    throw new Error(
      `eval: could not run git against commit range '${range}' - is it a valid range in this repository?`,
    );
  }

  const touched = nameStatus.map((parts) => parts[parts.length - 1]);
  const added = nameStatus.filter((parts) => parts[0].startsWith("A")).map((parts) => parts[parts.length - 1]);
  const sessions = [...new Set(commits.flatMap((commit) => [...commit.matchAll(/\[session: (.+?)\]/g)].map((m) => m[1])))].sort();
  const touchedMd = touched.filter((path) => path.endsWith(".md") && !isFrontmatterSkipped(path));
  const frontmatter = async (path: string) => parseFrontmatter(await host.readFileAtRef(path, end));

  const checks: NativeCheckResult[] = [];

  // Ports eval_session.py C1 commit message format.
  const badCommitMessages = commits.filter((commit) => !COMMIT_RE.test(commit.split(" ", 2)[1] ?? ""));
  checks.push({
    id: "C1-commit-format",
    applicable: true,
    passed: badCommitMessages.length === 0,
    detail: `${badCommitMessages.length} bad of ${commits.length}`,
  });

  // Ports eval_session.py C2 frontmatter valid on touched .md.
  const fmBad: string[] = [];
  for (const file of touchedMd) {
    const fm = await frontmatter(file);
    if (fm === null || FM_REQ.some((required) => !(required in fm))) fmBad.push(file);
  }
  checks.push({
    id: "C2-frontmatter",
    applicable: touchedMd.length > 0,
    passed: fmBad.length === 0,
    detail: fmBad.join(";") || "ok",
  });

  // Ports eval_session.py C3 agent ledger updated.
  checks.push({
    id: "C3-agents-log-row",
    applicable: true,
    passed: touched.includes("00-OPS/AGENTS-LOG.md"),
    detail: "",
  });

  // Ports eval_session.py C4 agent state flipped.
  let c4Passed = false;
  let c4Detail = "no state store configured here";
  if (host.hasStateStore) {
    if (sessions.length === 0) {
      c4Detail = "no [session: <id>] tags in range to look up";
    } else {
      const stateRow = (await host.stateStoreHasSessionRow?.(sessions)) ?? "unreachable";
      if (stateRow === true) {
        c4Passed = true;
        c4Detail = "state-store row";
      } else if (stateRow === false) {
        c4Detail = `no state-store row for ${sessions.join(", ")}`;
      } else {
        c4Detail = "state store CONFIGURED but unreachable, or driver missing - fix that before trusting this failure";
      }
    }
  }
  checks.push({
    id: "C4-agent-state",
    applicable: Boolean(host.hasStateStore),
    passed: c4Passed,
    detail: c4Detail,
  });

  // Ports eval_session.py C5 index hygiene.
  const addedMd = added.filter((path) => path.endsWith(".md") && !isFrontmatterSkipped(path));
  const idxTouched = touched.some((path) => /README|INDEX/.test(path.split("/").at(-1) ?? "") || path.startsWith("00-"));
  checks.push({
    id: "C5-index-updated",
    applicable: addedMd.length > 0,
    passed: idxTouched || addedMd.length === 0,
    detail: `${addedMd.length} added md`,
  });

  // Ports eval_session.py C6 research DoD.
  const research = touchedMd.filter((path) => path.startsWith("05-RESEARCH/"));
  const researchBad: string[] = [];
  for (const file of research) {
    const fm = (await frontmatter(file)) ?? {};
    if (!["citation", "url", "topic_cluster"].every((key) => key in fm)) researchBad.push(file);
  }
  checks.push({
    id: "C6-research-dod",
    applicable: research.length > 0,
    passed: researchBad.length === 0,
    detail: researchBad.join(";") || "ok",
  });

  // Ports eval_session.py C7 library DoD.
  const library = touched.filter(
    (path) => path.startsWith("07-LIBRARY/") && path.endsWith(".md") && !path.includes("INDEX") && !path.includes("_tools"),
  );
  const libraryBad: string[] = [];
  for (const file of library) {
    const fm = (await frontmatter(file)) ?? {};
    if (!["url", "captured", "recheck_after"].every((key) => key in fm)) libraryBad.push(file);
  }
  const libraryIndexOk = library.every((file) =>
    touched.some((path) => path.startsWith(file.split("/").slice(0, 2).join("/")) && path.includes("INDEX")),
  );
  checks.push({
    id: "C7-library-dod",
    applicable: library.length > 0,
    passed: libraryBad.length === 0 && libraryIndexOk,
    detail: libraryBad.join(";") || "ok",
  });

  // Ports eval_session.py C8 locked architecture docs require an ADR.
  const locked: string[] = [];
  for (const file of touchedMd.filter((path) => path.startsWith("01-ARCHITECTURE/"))) {
    if (((await frontmatter(file)) ?? {}).status?.trim() === "locked") locked.push(file);
  }
  const adrInRange = touched.some((path) => path.startsWith("01-ARCHITECTURE/ADRs/"));
  checks.push({
    id: "C8-locked-needs-adr",
    applicable: locked.length > 0,
    passed: adrInRange || locked.length === 0,
    detail: locked.join(";") || "none locked",
  });

  // Ports eval_session.py C9 data document definition of done.
  const dataDocs: string[] = [];
  for (const file of touchedMd) {
    if (((await frontmatter(file)) ?? {}).type?.trim() === "data") dataDocs.push(file);
  }
  const dataBad: string[] = [];
  for (const file of dataDocs) {
    const fm = (await frontmatter(file)) ?? {};
    if (!["pii", "license_terms"].every((key) => key in fm)) dataBad.push(file);
  }
  checks.push({
    id: "C9-data-dod",
    applicable: dataDocs.length > 0,
    passed: dataBad.length === 0,
    detail: dataBad.join(";") || "ok",
  });

  const applicable = checks.filter((check) => check.applicable);
  const passedApplicable = applicable.filter((check) => check.passed).length;
  return {
    range,
    commitCount: commits.length,
    touchedCount: touched.length,
    sessions,
    checks,
    passedApplicable,
    applicableCount: applicable.length,
  };
}

export function formatNativeCheckSummary(summary: NativeCheckSummary): string {
  const lines = [`eval ${summary.range}: ${summary.passedApplicable}/${summary.applicableCount} passed`];
  for (const check of summary.checks) {
    const mark = check.applicable ? (check.passed ? "PASS" : "FAIL") : "N/A ";
    lines.push(`  [${mark}] ${check.id}  ${check.detail}`);
  }
  return lines.join("\n");
}

export function localGitHost(cwd: string): NativeCheckHost {
  return {
    async git(args) {
      const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    },
    async readFileAtRef(path, ref) {
      try {
        const { stdout } = await execFileAsync("git", ["show", `${ref}:${path}`], {
          cwd,
          maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
      } catch {
        return null;
      }
    },
    hasStateStore: Boolean(process.env.DATABASE_URL || process.env.MEADOW_STATE_STORE_ENV),
  };
}
