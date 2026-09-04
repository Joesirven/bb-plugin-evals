Output ../media/memory-flow-demo.gif
Output ../media/memory-flow-demo.mp4

Require bb
Require jq

Set Shell "bash"
Set FontSize 23
Set FontFamily "DejaVu Sans Mono"
Set Width 1200
Set Height 676
Set Padding 28
Set Theme {"name":"BB Dark","black":"#090d18","red":"#ff718d","green":"#55e6a5","yellow":"#ffc86b","blue":"#58d8ff","magenta":"#aa8cff","cyan":"#58d8ff","white":"#f5f7fb","brightBlack":"#657089","brightRed":"#ff8aa1","brightGreen":"#7aefba","brightYellow":"#ffd78d","brightBlue":"#83e4ff","brightMagenta":"#bea8ff","brightCyan":"#83e4ff","brightWhite":"#ffffff","background":"#090d18","foreground":"#f5f7fb","selectionBackground":"#25324d","cursorAccent":"#090d18","cursor":"#58d8ff"}
Set TypingSpeed 18ms
Set Framerate 30
Set PlaybackSpeed 1
Set BorderRadius 14
Set WindowBar ColorfulRight
# 1. The compact index: what every agent turn gets injected, nothing more.
Type "bb memory catalog --scope all" Enter
Sleep 4s

# 2. Targeted search narrows recall to candidates.
Type 'bb memory search "plugin tool presentation" --scope all' Enter
Sleep 4s

# 3. Progressive disclosure: the full record loads only when selected.
Type "bb memory get mem_79bmwjsw-da --scope all --json | jq '.memory | {name, kind, scope, version, writeReason}'" Enter
Sleep 5s

# 4. Provenance: every write carries the thread and the reason it was saved.
Type "bb memory history mem_79bmwjsw-da | jq '[.[] | {version, action, write_reason}]'" Enter
Sleep 5s
