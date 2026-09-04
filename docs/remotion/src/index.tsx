import React from "react";
import {
  AbsoluteFill,
  Composition,
  Easing,
  interpolate,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import "./styles.css";

const palette = {
  background: "#090d18",
  panel: "#11182a",
  panelStrong: "#17223a",
  text: "#f5f7fb",
  muted: "#a7b0c2",
  cyan: "#58d8ff",
  violet: "#aa8cff",
  green: "#55e6a5",
  amber: "#ffc86b",
  red: "#ff718d",
};

const fade = (frame: number, start: number, duration = 18) =>
  interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

const enter = (frame: number, start: number, fps: number) =>
  spring({frame: frame - start, fps, config: {damping: 18, stiffness: 120}});

const Header: React.FC<{eyebrow: string; title: string; subtitle: string}> = ({
  eyebrow,
  title,
  subtitle,
}) => (
  <header className="header">
    <div className="eyebrow">{eyebrow}</div>
    <h1>{title}</h1>
    <p>{subtitle}</p>
  </header>
);

const Card: React.FC<{
  title: string;
  body: string;
  color: string;
  icon: string;
  progress: number;
  tag?: string;
}> = ({title, body, color, icon, progress, tag}) => (
  <div
    className="card"
    style={{
      borderColor: `${color}66`,
      opacity: progress,
      transform: `translateY(${(1 - progress) * 34}px) scale(${0.96 + progress * 0.04})`,
      boxShadow: `0 22px 70px ${color}12`,
    }}
  >
    <div className="cardTop">
      <span className="icon" style={{background: `${color}20`, color}}>{icon}</span>
      {tag ? <span className="tag" style={{color}}>{tag}</span> : null}
    </div>
    <h2>{title}</h2>
    <p>{body}</p>
  </div>
);

const Arrow: React.FC<{progress: number; color?: string}> = ({progress, color = palette.muted}) => (
  <div className="arrow" style={{opacity: progress}}>
    <div className="arrowLine" style={{background: color, transform: `scaleX(${progress})`}} />
    <div className="arrowHead" style={{borderLeftColor: color}} />
  </div>
);

const Footer: React.FC<{text: string; color?: string}> = ({text, color = palette.cyan}) => (
  <div className="footer">
    <span className="pulse" style={{background: color}} />
    {text}
  </div>
);

const EvalRatchetArchitecture: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const fixture = enter(frame, 38, fps);
  const run = enter(frame, 82, fps);
  const result = enter(frame, 128, fps);
  const proposal = enter(frame, 188, fps);
  const gate = enter(frame, 232, fps);
  const loop = enter(frame, 286, fps);

  return (
    <AbsoluteFill className="canvas">
      <div className="glow glowOne" />
      <div className="glow glowTwo" />
      <div style={{opacity: fade(frame, 0)}}>
        <Header
          eyebrow="BB EVALS · ARCHITECTURE"
          title="The eval ratchet"
          subtitle="Change context only when sealed evidence shows the agent got better."
        />
      </div>

      <div className="pipeline">
        <Card
          icon="◆"
          color={palette.cyan}
          tag="IMMUTABLE INPUT"
          title="Sealed fixtures"
          body="A content manifest freezes the scenarios. Any drift refuses the run."
          progress={fixture}
        />
        <Arrow progress={run} color={palette.cyan} />
        <Card
          icon="▶"
          color={palette.violet}
          tag="TWO LAYERS"
          title="Scored run"
          body="Deterministic checks and judge scores measure one context version."
          progress={run}
        />
        <Arrow progress={result} color={palette.violet} />
        <Card
          icon="↗"
          color={palette.green}
          tag="COMPARABLE"
          title="Trend evidence"
          body="Pass rates show whether the proposed context change actually helped."
          progress={result}
        />
      </div>

      <div className="lowerFlow" style={{opacity: proposal}}>
        <div className="failure" style={{borderColor: `${palette.red}70`}}>
          <span style={{color: palette.red}}>TRACED FAILURE</span>
          <strong>A specific scenario explains the gap</strong>
        </div>
        <Arrow progress={proposal} color={palette.red} />
        <div className="proposal" style={{borderColor: `${palette.amber}70`}}>
          <span style={{color: palette.amber}}>PROPOSAL</span>
          <strong>Amendment + evidence + prediction</strong>
        </div>
        <Arrow progress={gate} color={palette.amber} />
        <div className="gate" style={{borderColor: `${palette.green}70`}}>
          <span style={{color: palette.green}}>HUMAN GATE</span>
          <strong>Adopt or decline</strong>
          <small>No apply operation exists</small>
        </div>
      </div>

      <div className="loop" style={{opacity: loop}}>
        <span>Human edits context</span>
        <span className="loopArrow">→</span>
        <span>New sealed run</span>
        <span className="loopArrow">→</span>
        <span>Measured improvement</span>
      </div>

      <div style={{opacity: fade(frame, 308)}}>
        <Footer text="A feedback loop with a hard human boundary" color={palette.green} />
      </div>
    </AbsoluteFill>
  );
};

const AgentMemoryArchitecture: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const index = enter(frame, 36, fps);
  const search = enter(frame, 80, fps);
  const record = enter(frame, 124, fps);
  const scopes = enter(frame, 174, fps);
  const providers = enter(frame, 218, fps);
  const bridge = enter(frame, 272, fps);

  return (
    <AbsoluteFill className="canvas">
      <div className="glow glowOne" />
      <div className="glow glowThree" />
      <div style={{opacity: fade(frame, 0)}}>
        <Header
          eyebrow="BB MEMORY · ARCHITECTURE"
          title="Durable recall without flooding context"
          subtitle="A provider-independent store reveals only the detail an agent needs."
        />
      </div>

      <div className="memoryRail">
        <Card
          icon="≡"
          color={palette.cyan}
          tag="EVERY TURN"
          title="Compact index"
          body="Short global and project summaries are injected into agent context."
          progress={index}
        />
        <Arrow progress={search} color={palette.cyan} />
        <Card
          icon="⌕"
          color={palette.violet}
          tag="ON DEMAND"
          title="Targeted search"
          body="Full-text search narrows recall to relevant candidate memories."
          progress={search}
        />
        <Arrow progress={record} color={palette.violet} />
        <Card
          icon="□"
          color={palette.green}
          tag="PROGRESSIVE"
          title="Full record"
          body="Details, provenance, version, and history load only when selected."
          progress={record}
        />
      </div>

      <div className="memoryBase" style={{opacity: scopes}}>
        <div className="store">
          <div className="database">◎</div>
          <div>
            <span>PLUGIN-PRIVATE STORE</span>
            <strong>Global scope · Project scope</strong>
            <small>Version-checked updates · Soft deletion</small>
          </div>
        </div>
        <div className="providerGroup" style={{opacity: providers}}>
          <span>ONE RECALL LAYER</span>
          <div className="providerPills">
            <b>Codex</b><b>Claude Code</b><b>Other agents</b>
          </div>
        </div>
      </div>

      <div className="humanBridge" style={{opacity: bridge}}>
        <div>
          <span style={{color: palette.amber}}>EVAL RATCHET EVIDENCE</span>
          <strong>Adopted or declined proposal</strong>
        </div>
        <div className="bridgeArrow">human review →</div>
        <div>
          <span style={{color: palette.cyan}}>DURABLE MEMORY</span>
          <strong>Only verified learning is stored</strong>
        </div>
      </div>

      <div style={{opacity: fade(frame, 310)}}>
        <Footer text="Memory helps the next agent recall; evals verify that recall improves behavior" />
      </div>
    </AbsoluteFill>
  );
};

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="EvalRatchetArchitecture"
      component={EvalRatchetArchitecture}
      durationInFrames={360}
      fps={30}
      width={1200}
      height={675}
    />
    <Composition
      id="AgentMemoryArchitecture"
      component={AgentMemoryArchitecture}
      durationInFrames={360}
      fps={30}
      width={1200}
      height={675}
    />
  </>
);

import {registerRoot} from "remotion";
registerRoot(RemotionRoot);
