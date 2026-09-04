# Documentation media

Source for the architecture videos and terminal demos embedded in the top-level
[README](../README.md). Rendered output lands in `docs/media/` and is committed,
so nobody needs a toolchain just to read the README.

## Architecture videos (Remotion)

Source: `docs/remotion/src/index.tsx`, two compositions at 1200x675, 30 frames
per second.

- `EvalRatchetArchitecture` — sealed fixtures, scored runs, human-gated proposals.
- `AgentMemoryArchitecture` — the compact index, targeted search, full record.

Regenerate both, as MP4 and GIF:

```
cd docs/remotion
npm install
npm run render:all
```

Remotion downloads a headless Chrome on first run.

## Terminal demos (VHS)

Source: `docs/demos/*.tape`, recorded with
[VHS](https://github.com/charmbracelet/vhs). Requires `vhs`, `ttyd`, `ffmpeg`,
`jq`, and a working `bb` on `PATH`.

```
cd docs/demos
vhs evals-flow.tape
vhs memory-flow.tape
```

Two things to know before re-recording:

- **The tapes run real commands against real local state.** Every command is
  read-only: `status`, `fixtures`, `verify`, `trend`, `proposals`, and the
  `bb memory` read commands. Nothing in a tape opens a run, seals a fixture
  set, or writes a memory. Output will differ on a machine with different
  fixture sets, runs, or memories.
- **Height must stay even.** The H.264 encoder rejects odd dimensions, so
  `Set Height 676` rather than 675. The Remotion compositions are unaffected,
  since Remotion pads on its own.

The evals tape deliberately verifies a drifted fixture set (`x-demo`) right
after an intact one (`ratchet-core`), because the refusal is the point.
