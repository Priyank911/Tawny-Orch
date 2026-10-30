from hashlib import sha256
from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else "release-assets").resolve()
if not root.is_dir():
    raise SystemExit(f"Release asset directory does not exist: {root}")

files = sorted(path for path in root.iterdir() if path.is_file() and path.name != "SHA256SUMS.txt")
if not files:
    raise SystemExit("No release files found; refusing to publish an empty checksum manifest.")

lines = []
for path in files:
    digest = sha256(path.read_bytes()).hexdigest()
    lines.append(f"{digest}  {path.name}")
(root / "SHA256SUMS.txt").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
print(f"Wrote SHA256SUMS.txt for {len(files)} release files.")
