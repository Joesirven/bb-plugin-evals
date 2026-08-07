import { useCallback, useEffect, useMemo, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Proposal = Awaited<ReturnType<ReturnType<typeof useRpc<typeof rpcContract>>["call"]>>;

const tabs = [
  { id: "proposals", label: "Proposals" },
  { id: "runs", label: "Runs" },
  { id: "trend", label: "Trend" },
  { id: "fixtures", label: "Fixtures" },
] as const;

type TabId = (typeof tabs)[number]["id"];

function percent(value: number | null) {
  return value === null ? "--" : `${Math.round(value * 100)}%`;
}

function activeTab(subPath: string): TabId {
  const first = subPath.split("/").filter(Boolean)[0];
  return tabs.some((tab) => tab.id === first) ? (first as TabId) : "proposals";
}

function EvalsPanel({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const connection = useRealtimeConnectionState();
  const tab = activeTab(subPath);
  const [refreshKey, setRefreshKey] = useState(0);

  useRealtime("proposals-changed", () => setRefreshKey((value) => value + 1));
  useRealtime("runs-changed", () => setRefreshKey((value) => value + 1));

  useEffect(() => {
    if (connection === "connected") setRefreshKey((value) => value + 1);
  }, [connection]);

  return (
    <div className="min-h-full bg-background text-foreground">
      <div className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap gap-2">
          {tabs.map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={tab === item.id ? "default" : "outline"}
              onClick={() => navigate.toPluginPanel("evals", { subPath: item.id === "proposals" ? "" : item.id })}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </div>
      <div className="p-4 md:p-5">
        {tab === "proposals" ? <ProposalsTab rpc={rpc} refreshKey={refreshKey} /> : null}
        {tab === "runs" ? <RunsTab rpc={rpc} refreshKey={refreshKey} /> : null}
        {tab === "trend" ? <TrendTab rpc={rpc} refreshKey={refreshKey} /> : null}
        {tab === "fixtures" ? <FixturesTab rpc={rpc} refreshKey={refreshKey} /> : null}
      </div>
    </div>
  );
}

function ProposalsTab({ rpc, refreshKey }: { rpc: ReturnType<typeof useRpc<typeof rpcContract>>; refreshKey: number }) {
  const [status, setStatus] = useState("open");
  const [proposals, setProposals] = useState<Array<{
    id: string;
    runId: string;
    scenario: string;
    tracedFailure: string;
    evidence: string | null;
    amendment: string;
    targetPath: string | null;
    taskKey: string | null;
    status: string;
    createdAt: string;
    feedbackNote: string | null;
    decidedAt: string | null;
    prediction: string | null;
  }>>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    void rpc.call("listProposals", status === "all" ? {} : { status }).then((result) => setProposals(result.proposals));
  }, [rpc, status]);

  useEffect(load, [load, refreshKey]);

  async function decide(id: string, nextStatus: "adopted" | "declined") {
    const note = notes[id]?.trim();
    if (!note) return;
    await rpc.call("updateProposalStatus", { id, status: nextStatus, note });
    setNotes((current) => ({ ...current, [id]: "" }));
    load();
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {["open", "filed", "adopted", "declined", "all"].map((item) => (
          <Button key={item} size="sm" variant={status === item ? "default" : "outline"} onClick={() => setStatus(item)}>
            {item}
          </Button>
        ))}
      </div>
      <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
        Marking adopted records your decision. Copy the amendment into the target document yourself.
      </div>
      {proposals.length === 0 ? <p className="text-sm text-muted-foreground">No proposals in this view.</p> : null}
      {proposals.map((proposal) => (
        <Card key={proposal.id}>
          <CardHeader>
            <CardTitle className="text-base">{proposal.scenario}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid gap-2 md:grid-cols-2">
              <Field label="Status" value={proposal.status} />
              <Field label="Run" value={proposal.runId} />
              <Field label="Target" value={proposal.targetPath ?? "--"} />
              <Field label="Task" value={proposal.taskKey ?? "--"} />
            </div>
            <Block label="Traced Failure" value={proposal.tracedFailure} />
            <Block label="Evidence" value={proposal.evidence ?? "_none recorded_"} />
            <Block label="Amendment" value={proposal.amendment} />
            {proposal.prediction ? <Block label="Prediction" value={proposal.prediction} /> : null}
            {proposal.status === "open" || proposal.status === "filed" ? (
              <div className="flex flex-col gap-2 md:flex-row md:items-center">
                <Input
                  value={notes[proposal.id] ?? ""}
                  onChange={(event) => setNotes((current) => ({ ...current, [proposal.id]: event.target.value }))}
                  placeholder="Required feedback note"
                />
                <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(proposal.amendment)}>
                  Copy Amendment
                </Button>
                <Button size="sm" disabled={!notes[proposal.id]?.trim()} onClick={() => void decide(proposal.id, "adopted")}>
                  Adopt
                </Button>
                <Button size="sm" variant="destructive" disabled={!notes[proposal.id]?.trim()} onClick={() => void decide(proposal.id, "declined")}>
                  Decline
                </Button>
              </div>
            ) : (
              <Block label="Feedback" value={proposal.feedbackNote ?? "--"} />
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function RunsTab({ rpc, refreshKey }: { rpc: ReturnType<typeof useRpc<typeof rpcContract>>; refreshKey: number }) {
  const [runs, setRuns] = useState<Array<{
    id: string;
    fixtureSetId: string;
    startedAt: string;
    finishedAt: string | null;
    status: string;
    contextVersion: string | null;
    deterministicPassRate: number | null;
    judgePassRate: number | null;
    refusalReason: string | null;
    scenarioCount: number;
  }>>([]);

  useEffect(() => {
    void rpc.call("listRuns", { limit: 50 }).then((result) => setRuns(result.runs));
  }, [rpc, refreshKey]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-3">
      {runs.map((run) => (
        <Card key={run.id} className={run.status === "refused" ? "border-destructive" : ""}>
          <CardContent className="grid gap-2 p-4 text-sm md:grid-cols-6">
            <Field label="Run" value={run.id} />
            <Field label="Status" value={run.status} />
            <Field label="Deterministic" value={percent(run.deterministicPassRate)} />
            <Field label="Judge" value={percent(run.judgePassRate)} />
            <Field label="Context" value={run.contextVersion ?? "--"} />
            <Field label="Scenarios" value={String(run.scenarioCount)} />
            {run.refusalReason ? <div className="md:col-span-6 text-destructive">{run.refusalReason}</div> : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TrendTab({ rpc, refreshKey }: { rpc: ReturnType<typeof useRpc<typeof rpcContract>>; refreshKey: number }) {
  const [sets, setSets] = useState<Array<{
    fixtureSetId: string;
    name: string;
    holdout: boolean;
    points: Array<{ runId: string; at: string; contextVersion: string | null; deterministicPassRate: number | null; judgePassRate: number | null }>;
  }>>([]);

  useEffect(() => {
    void rpc.call("trendOverview").then((result) => setSets(result.sets));
  }, [rpc, refreshKey]);

  const hasHoldout = sets.some((set) => set.holdout);
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      {hasHoldout ? <p className="text-sm text-muted-foreground">Working-set and holdout pass rates are shown side by side for overfitting checks.</p> : null}
      {sets.map((set) => (
        <Card key={set.fixtureSetId}>
          <CardHeader>
            <CardTitle className="text-base">{set.name}{set.holdout ? " [holdout]" : ""}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {set.points.length === 0 ? <p className="text-sm text-muted-foreground">No completed runs.</p> : null}
            {set.points.map((point) => (
              <div key={point.runId} className="grid gap-2 text-sm md:grid-cols-[9rem_1fr_5rem_5rem] md:items-center">
                <span>{point.at.slice(0, 10)}</span>
                <span className="text-muted-foreground">{point.contextVersion ?? "--"}</span>
                <Bar label="det" value={point.deterministicPassRate} />
                <Bar label="judge" value={point.judgePassRate} />
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function FixturesTab({ rpc, refreshKey }: { rpc: ReturnType<typeof useRpc<typeof rpcContract>>; refreshKey: number }) {
  const [sets, setSets] = useState<Array<{ id: string; name: string; rootPath: string; fileCount: number; sealedAt: string; holdout: boolean }>>([]);
  const [verify, setVerify] = useState<Record<string, string>>({});

  useEffect(() => {
    void rpc.call("listFixtureSets").then((result) => setSets(result.sets));
  }, [rpc, refreshKey]);

  async function verifySet(id: string) {
    const result = await rpc.call("verifyFixtureSet", { id });
    setVerify((current) => ({ ...current, [id]: result.drifted ? `drifted: ${result.reason}` : "intact" }));
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-3">
      {sets.map((set) => (
        <Card key={set.id}>
          <CardContent className="grid gap-2 p-4 text-sm md:grid-cols-[1fr_8rem_12rem_6rem_auto] md:items-center">
            <Field label="Set" value={`${set.name}${set.holdout ? " [holdout]" : ""}`} />
            <Field label="Files" value={String(set.fileCount)} />
            <Field label="Sealed" value={set.sealedAt.slice(0, 10)} />
            <span className="text-muted-foreground">{verify[set.id] ?? ""}</span>
            <Button size="sm" variant="outline" onClick={() => void verifySet(set.id)}>Verify</Button>
            <div className="md:col-span-5 text-muted-foreground">{set.rootPath}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="truncate">{value}</div>
    </div>
  );
}

function Block({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 font-sans text-sm">{value}</pre>
    </div>
  );
}

function Bar({ label, value }: { label: string; value: number | null }) {
  const width = `${Math.round((value ?? 0) * 100)}%`;
  return (
    <div className="min-w-0">
      <div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>{label}</span><span>{percent(value)}</span></div>
      <div className="h-2 rounded-sm bg-muted">
        <div className="h-2 rounded-sm bg-foreground" style={{ width }} />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "evals",
    title: "Evals",
    icon: "Gauge",
    path: "evals",
    component: EvalsPanel,
  });
});
