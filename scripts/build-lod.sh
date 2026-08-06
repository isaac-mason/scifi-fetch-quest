#!/usr/bin/env bash
# Build the runtime streaming-LOD splat (.rad) from a source .spz using Spark's Rust
# `build-lod` tool. That tool ships in the SPARK SOURCE repo (not the npm package), so this
# is a thin wrapper: point SPARK_REPO at your checkout (defaults to ~/Development/spark-gpu).
#
# Usage:
#   pnpm build:lod [input.spz]          # default: assets/scifi_world.spz
#   SPARK_REPO=/path/to/spark pnpm build:lod
#
# Output: public/<name>-lod.rad (the .rad the app loads; see SPLAT_URL in src/scene.ts).
set -euo pipefail

INPUT="${1:-assets/scifi_world.spz}"
SPARK_REPO="${SPARK_REPO:-$HOME/Development/spark-gpu}"
MANIFEST="$SPARK_REPO/rust/build-lod/Cargo.toml"

command -v cargo >/dev/null 2>&1 || { echo "error: cargo (Rust) not found on PATH — install Rust to build the LOD." >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "error: build-lod not found at $MANIFEST — clone the Spark repo and set SPARK_REPO=/path/to/spark." >&2; exit 1; }
[ -f "$INPUT" ] || { echo "error: input splat not found: $INPUT" >&2; exit 1; }

echo "Building LOD from $INPUT  (build-lod @ $SPARK_REPO)…"
cargo run --manifest-path "$MANIFEST" --release -- "$INPUT" --rad

# build-lod writes "<name>-lod.rad" next to the input; move it into public/.
name="$(basename "${INPUT%.*}")"
mkdir -p public
mv -f "$(dirname "$INPUT")/${name}-lod.rad" "public/${name}-lod.rad"
echo "Wrote public/${name}-lod.rad"
