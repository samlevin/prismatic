#!/bin/sh
# Runs the scoped-fetch spike inside the pinned Action image, as the image's
# unprivileged user, with the repository's experiments/ and src/ mounted
# read-only. The JSON results go to stdout and progress to stderr.
#
# Usage: experiments/fetch/run-in-image.sh [spike options]
#   --skip-large                         leave out the 2 GiB fixture
#   --github <owner/repo> <pr> <sha>     also run against a GitHub repository,
#                                        with <sha> an earlier head of the PR
#
# Set PRISMATIC_SPIKE_IMAGE to use an image you already built from this
# commit; otherwise the script builds one.
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
image=${PRISMATIC_SPIKE_IMAGE:-}
if [ -z "$image" ]; then
  image=prismatic-fetch-spike:local
  docker build --quiet --tag "$image" "$root" >&2
fi

# The default bridge network is needed only for --github; the fixture
# remotes are local file:// repositories inside the container.
exec docker run --rm \
  --user 10001:10001 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --volume "$root/experiments:/spike/experiments:ro" \
  --volume "$root/src:/spike/src:ro" \
  --entrypoint /usr/local/bin/node \
  "$image" /spike/experiments/fetch/spike/main.ts "$@"
