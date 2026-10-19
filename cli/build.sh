#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
go_command="${GO:-go}"
version="${VERSION:-0.1.2}"
mkdir -p dist
for arch in amd64 arm64; do
  package="xcopy_${version}_linux_${arch}"
  mkdir -p "dist/${package}"
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" "$go_command" build -trimpath -ldflags="-s -w -X main.version=${version}" -o "dist/${package}/xcopy" ./cmd/xcopy
  cp README.md "dist/${package}/README.md"
  cp install.sh "dist/${package}/install.sh"
  cp THIRD_PARTY_LICENSES.txt "dist/${package}/THIRD_PARTY_LICENSES.txt"
  COPYFILE_DISABLE=1 tar --no-xattrs -C dist -czf "dist/${package}.tar.gz" "$package"
done
cd dist
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "xcopy_${version}_linux_amd64.tar.gz" "xcopy_${version}_linux_arm64.tar.gz" > SHA256SUMS
else
  shasum -a 256 "xcopy_${version}_linux_amd64.tar.gz" "xcopy_${version}_linux_arm64.tar.gz" > SHA256SUMS
fi
cat SHA256SUMS
