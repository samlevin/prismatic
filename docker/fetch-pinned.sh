#!/bin/sh
# Downloads one artifact listed in docker/binaries.lock and keeps it only when
# its SHA-256 matches the lock. Runs during the image build, never in the
# running container.
#
# Usage: fetch-pinned.sh <lock file> <name> <platform> <output file>
# -f turns off filename expansion for the unquoted `set --` below.
set -euf

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <lock file> <name> <platform> <output file>" >&2
  exit 2
fi
lock=$1
name=$2
platform=$3
output=$4

# Exactly one entry may match, so a duplicated or missing line fails the
# build instead of picking one silently.
matches=$(awk -v name="$name" -v platform="$platform" \
  '$1 !~ /^#/ && $1 == name && $3 == platform' "$lock")
count=$(printf '%s\n' "$matches" | grep -c . || true)
if [ "$count" -ne 1 ]; then
  echo "expected one $name entry for $platform in $lock, found $count" >&2
  exit 1
fi

set -- $matches
if [ "$#" -ne 5 ]; then
  echo "malformed $name entry for $platform in $lock" >&2
  exit 1
fi
sha256=$4
url=$5

if ! printf '%s\n' "$sha256" | grep -Eqx '[0-9a-f]{64}'; then
  echo "the $name entry for $platform has no valid SHA-256" >&2
  exit 1
fi
case "$url" in
  https://*) ;;
  *)
    echo "the $name entry for $platform must use an https URL" >&2
    exit 1
    ;;
esac

curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  --output "$output" "$url"
if ! printf '%s  %s\n' "$sha256" "$output" | sha256sum --check --status; then
  rm -f "$output"
  echo "SHA-256 mismatch for $name $platform from $url" >&2
  exit 1
fi
echo "verified $name $platform $sha256"
