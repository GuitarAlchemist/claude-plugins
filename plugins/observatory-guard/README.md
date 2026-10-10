# Observatory guard configuration

Configure both projects and their corresponding Godot executables in the environment of the
Claude Code session before using the guard. There are no built-in machine-specific paths.

```powershell
$env:OBSERVATORY_GUARD_ROOTS = 'C:/prototype;D:/demo-copy'
$env:OBSERVATORY_GUARD_GODOT = 'C:/tools/godot-stock.exe;D:/tools/godot-dlss.exe'
```

Each variable contains exactly two absolute paths separated by a semicolon, in prototype/copy
order. Projects must be distinct and must not overlap. The configured copy uses the second
checker regardless of its folder name; an alternate incoming source project uses the first.
The source must have its own `project.godot`. A missing checker or project produces an explicit
unchecked warning after an edit/write and refuses a protected copy. Missing, unreadable or
malformed configuration refuses shell operations rather than falling back to host defaults.

Literal single-script `Copy-Item`, `cp` and `copy` commands are checked before copying into the
configured copy. Directory, wildcard, computed and wrapper copies are unsupported and held for
an explicit supported command. Copy batches are bounded to twelve scripts. Lexical path
normalization handles slash differences and dot segments before project containment checks;
UNC/device paths and traversal above the filesystem anchor are refused. This does not resolve
filesystem aliases or symlinks and is not an atomic guarantee against source changes after checking.

The guard watches `.gd` files directly in `scripts` and `artpass/dlss`. Removed scripts produce
warnings without trying to execute them. `/godot` displays checks and process observations;
these observations do not replace the user's permission for disturbing an active demo.
