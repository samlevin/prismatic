# The Prismatic Action image: Node.js 24, Git, and ast-grep. Nothing is
# installed when the container starts. docker/runtime-policy.md describes the
# rules the image and its entrypoint follow.
#
# There is no USER instruction. GitHub starts container actions as root, and
# apps/action/main.ts drops to the unprivileged `prismatic` user itself
# before it starts any child process.

# Pinned by the digest of the multi-platform index, so every stage and every
# platform starts from the same published image.
FROM node:24.22.0-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS base

# Download tools for the build stages. The runtime stage never gets them.
FROM base AS fetch
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY docker/binaries.lock docker/fetch-pinned.sh /pinned/

# Git from its release tarball, checked against docker/binaries.lock. Perl,
# Python, Tcl/Tk, translations, and the optional Rust code are left out, so
# the build needs no toolchain beyond the C compiler; HTTPS fetches go through
# libcurl. Dashed built-ins are not installed, and the remaining helper links
# are symbolic, so the copy into the runtime stage stays small.
FROM fetch AS git-build
RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    gcc libc6-dev libcurl4-openssl-dev libexpat1-dev make xz-utils zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*
RUN sh /pinned/fetch-pinned.sh /pinned/binaries.lock git source /tmp/git.tar.xz \
  && mkdir /tmp/git \
  && tar -xJf /tmp/git.tar.xz -C /tmp/git --strip-components=1
WORKDIR /tmp/git
RUN make -j"$(nproc)" \
    prefix=/usr/local \
    CFLAGS='-O2 -fstack-protector-strong -D_FORTIFY_SOURCE=2' \
    LDFLAGS='-Wl,-z,relro -Wl,-z,now' \
    NO_GETTEXT=YesPlease NO_PERL=YesPlease NO_PYTHON=YesPlease \
    NO_TCLTK=YesPlease NO_RUST=YesPlease \
    INSTALL_SYMLINKS=YesPlease SKIP_DASHED_BUILT_INS=YesPlease \
    DESTDIR=/out install \
  && expected="git version $(awk '$1 == "git" { print $2; exit }' /pinned/binaries.lock)" \
  && actual="$(/out/usr/local/bin/git --version)" \
  && test "$actual" = "$expected"

# ast-grep from its release archive for the target platform, checked against
# docker/binaries.lock.
FROM fetch AS ast-grep-build
ARG TARGETOS
ARG TARGETARCH
RUN apt-get update \
  && apt-get install --yes --no-install-recommends unzip \
  && rm -rf /var/lib/apt/lists/*
RUN sh /pinned/fetch-pinned.sh /pinned/binaries.lock ast-grep \
    "$TARGETOS/$TARGETARCH" /tmp/ast-grep.zip \
  && mkdir /out \
  && unzip -q /tmp/ast-grep.zip ast-grep -d /out \
  && chmod 0755 /out/ast-grep \
  && expected="ast-grep $(awk '$1 == "ast-grep" { print $2; exit }' /pinned/binaries.lock)" \
  && actual="$(/out/ast-grep --version)" \
  && test "$actual" = "$expected"

# The TypeScript build. Development dependencies stay in this stage.
FROM base AS app
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY apps ./apps
RUN npm run build

# The runtime image. It keeps the shared libraries Git links against and the
# CA certificates for HTTPS, removes npm, npx, corepack, and yarn so no
# Node.js package manager is left at run time, and adds the unprivileged user
# the entrypoint drops to. Everything copied here belongs to root, so that user
# cannot change the code or the binaries.
FROM base AS runtime
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates libcurl4t64 libexpat1 \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
  && groupadd --system --gid 10001 prismatic \
  && useradd --system --uid 10001 --gid prismatic --home-dir /nonexistent \
    --no-create-home --shell /usr/sbin/nologin prismatic
COPY --from=git-build /out/usr/local/ /usr/local/
COPY --from=ast-grep-build /out/ast-grep /usr/local/bin/ast-grep
COPY --from=app /build/package.json /opt/prismatic/package.json
COPY --from=app /build/dist/ /opt/prismatic/
ENV NODE_ENV=production
ENTRYPOINT ["/usr/local/bin/node", "/opt/prismatic/apps/action/main.js"]
