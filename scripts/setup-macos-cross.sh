#!/usr/bin/env bash
set -euo pipefail

sdk_root="${RUNNER_TEMP:?}/sora-macos-sdk"
mkdir -p "$sdk_root"
curl -fL --retry 3 -o "$sdk_root/sdk.tar.xz" \
  https://github.com/joseluisq/macosx-sdks/releases/download/14.5/MacOSX14.5.sdk.tar.xz
printf '%s  %s\n' 6e146275d19f027faa2e8354da5e0267513abf013b8f16ad65a231653a2b1c5d "$sdk_root/sdk.tar.xz" | sha256sum -c -
tar -xJf "$sdk_root/sdk.tar.xz" -C "$sdk_root"
sdk_path="$sdk_root/MacOSX14.5.sdk"
test -d "$sdk_path/usr/lib"
linker="$sdk_root/clang-arm64"
cat > "$linker" <<LINKER
#!/bin/sh
exec /usr/bin/clang --target=arm64-apple-macos11 -Wl,-platform_version,macos,11.0,14.5 -isysroot "$sdk_path" -fuse-ld=/usr/bin/ld64.lld "\$@"
LINKER
chmod +x "$linker"
{
  echo "SDKROOT=$sdk_path"
  echo 'MACOSX_DEPLOYMENT_TARGET=11.0'
  echo "CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER=$linker"
  echo "CC_aarch64_apple_darwin=$linker"
} >> "${GITHUB_ENV:?}"
