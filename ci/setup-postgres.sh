#!/usr/bin/env bash
set -euo pipefail

# Installs test binaries only. The existing test helper owns each temporary cluster.
: "${RUNNER_TEMP:?Run inside the CI runner}"
: "${GITHUB_ENV:?Missing GitHub Actions environment file}"
test "$(id -u)" -ne 0

repository=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
version=$(cat "$repository/.postgres-version")
[[ "$version" =~ ^17\.[0-9]+$ ]]
archive="postgresql-$version.tar.bz2"
checksum_file="$repository/ci/postgresql-source.sha256"
# Updating the version also requires reviewing its source checksum.
read -r checksum checksum_archive < "$checksum_file"
[[ "$checksum" =~ ^[[:xdigit:]]{64}$ ]]
test "$checksum_archive" = "$archive"

sudo apt-get update
sudo apt-get install --yes --no-install-recommends \
  build-essential bison flex pkg-config libssl-dev zlib1g-dev ca-certificates curl bzip2

work=$(mktemp -d "$RUNNER_TEMP/quenda-pg-build.XXXXXX")
prefix=$(mktemp -d "$RUNNER_TEMP/quenda-pg-install.XXXXXX")
trap 'rm -rf "$work"' EXIT
cd "$work"
curl --fail --show-error --silent --location --retry 3 \
  --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 300 \
  "https://ftp.postgresql.org/pub/source/v$version/$archive" --output "$archive"
sha256sum --check "$checksum_file"
tar -xjf "$archive"
cd "postgresql-$version"
./configure --prefix="$prefix" --without-readline --without-icu --with-openssl
make -j2
make install
make -C contrib/btree_gist -j2
make -C contrib/btree_gist install

test "$("$prefix/bin/postgres" --version)" = "postgres (PostgreSQL) $version"
test -f "$("$prefix/bin/pg_config" --sharedir)/extension/btree_gist.control"
printf 'PG_BIN=%s/bin\n' "$prefix" >> "$GITHUB_ENV"
