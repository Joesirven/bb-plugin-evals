Output ../media/evals-flow-demo.gif
Output ../media/evals-flow-demo.mp4

Require bb

Set Shell "bash"
Set FontSize 24
Set FontFamily "DejaVu Sans Mono"
Set Width 1200
Set Height 676
Set Padding 28
Set Theme {"name":"BB Dark","black":"#090d18","red":"#ff718d","green":"#55e6a5","yellow":"#ffc86b","blue":"#58d8ff","magenta":"#aa8cff","cyan":"#58d8ff","white":"#f5f7fb","brightBlack":"#657089","brightRed":"#ff8aa1","brightGreen":"#7aefba","brightYellow":"#ffd78d","brightBlue":"#83e4ff","brightMagenta":"#bea8ff","brightCyan":"#83e4ff","brightWhite":"#ffffff","background":"#090d18","foreground":"#f5f7fb","selectionBackground":"#25324d","cursorAccent":"#090d18","cursor":"#58d8ff"}
Set TypingSpeed 24ms
Set Framerate 30
Set PlaybackSpeed 1
Set BorderRadius 14
Set WindowBar ColorfulRight

# 1. What the ratchet is tracking right now.
Type "bb evals status" Enter
Sleep 4s

# 2. The sealed fixture sets that scoring is allowed to run against.
Type "bb evals fixtures" Enter
Sleep 4s

# 3. An intact seal: the manifest hash still matches the fixture contents.
Type "bb evals verify ratchet-core" Enter
Sleep 4s

# 4. A drifted seal. This is the invariant: scoring refuses rather than
#    silently optimizing against a moving target.
Type "bb evals verify x-demo" Enter
Sleep 4s

# 5. Pass-rate trend for one context version.
Type "bb evals trend ratchet-core" Enter
Sleep 4s

# 6. A traced failure filed as a task. Never applied automatically.
Type "bb evals proposals --status filed" Enter
Sleep 7s
