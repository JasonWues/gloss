#!/bin/bash

# Node 22, not 19.8.1. `npm install pnpm -g` takes the latest pnpm, and pnpm 11
# refuses to start on anything below Node 22.13 -- so this pairing broke on its
# own the day pnpm 11 shipped, without the file changing.
NODE_VERSION=v22.20.0
wget "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz"
tar -Jxvf "./node-${NODE_VERSION}-linux-x64.tar.xz"
export PATH=$(pwd)/node-${NODE_VERSION}-linux-x64/bin:$PATH
npm install pnpm@11 -g

rustup target add "$INPUT_TARGET"
rustup toolchain install --force-non-host "$INPUT_TOOLCHAIN"

# xcap 0.9 (the screenshot backend) depends on `pipewire` unconditionally on
# Linux -- it is how it captures under Wayland, and it is not behind a feature,
# so there is nothing to switch off. That pulls `libspa-sys`, which needs
# `libpipewire-0.3.pc` at build time AND runs bindgen over its headers, so
# libclang has to be present too; `rust:bookworm` ships neither.
#
# The same Wayland path also links against gbm and EGL (`-lgbm -lEGL`, via the
# `gbm`/`gbm-sys`/`khronos_egl` crates). `rust:bookworm` carries the runtime
# libraries but not the `.so` symlinks, so those need the -dev packages too --
# a missing one shows up as `rust-lld: error: unable to find library -lgbm`
# only at the final link, long after everything has compiled.
#
# bindgen is a host tool even when the build is cross, so clang is the one thing
# here that never carries an architecture suffix.
BINDGEN_DEPS="clang libclang-dev"

# This script has no `set -e`, so a failed `apt-get install` used to be
# invisible: the packages were silently absent and the build carried on to
# cargo, which died ten or so minutes later inside gdk-sys with "The system
# library `gdk-3.0` was not found" -- an error about pkg-config describing an
# apt problem that had long scrolled off the top of the log. All three
# cross-architecture targets have been failing that way.
#
# Not `set -e` at the top, which would make every command in the file fatal
# including ones that have always been allowed to fail. This stops at the one
# step whose failure is worth stopping for, and says so in the annotation.
apt_install() {
    if ! apt-get install -y "$@"; then
        echo "::error::apt-get install failed for $INPUT_TARGET -- see the apt output above for the package it could not satisfy"
        exit 1
    fi
}

if [ "$INPUT_TARGET" = "x86_64-unknown-linux-gnu" ]; then
    apt-get update
    apt_install libgtk-3-dev libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev xdg-utils patchelf libxdo-dev libxcb1 libxrandr2 libdbus-1-3 libpipewire-0.3-dev libspa-0.2-dev libgbm-dev libdrm-dev libegl-dev $BINDGEN_DEPS
elif [ "$INPUT_TARGET" = "aarch64-unknown-linux-gnu" ]; then
    dpkg --add-architecture arm64
    apt-get update
    apt_install libncurses6:arm64 libtinfo6:arm64 linux-libc-dev:arm64 libncursesw6:arm64 libcups2:arm64
    apt_install --no-install-recommends g++-aarch64-linux-gnu libc6-dev-arm64-cross libssl-dev:arm64 libwebkit2gtk-4.1-dev:arm64 libjavascriptcoregtk-4.1-dev:arm64 libsoup-3.0-dev:arm64 libgtk-3-dev:arm64 patchelf:arm64 xdg-utils librsvg2-dev:arm64 libxdo-dev:arm64 libxcb1:arm64 libxrandr2:arm64 libdbus-1-3:arm64 libayatana-appindicator3-dev:arm64 libpipewire-0.3-dev:arm64 libspa-0.2-dev:arm64 libgbm-dev:arm64 libdrm-dev:arm64 libegl-dev:arm64 $BINDGEN_DEPS
    export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
    export CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc
    export CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++
    export PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig
    export PKG_CONFIG_ALLOW_CROSS=1
    # libspa-sys's build.rs never passes --target to clang, so bindgen would
    # otherwise parse these headers with host (x86_64) type sizes.
    export BINDGEN_EXTRA_CLANG_ARGS="--target=aarch64-linux-gnu -I/usr/include/aarch64-linux-gnu"
else
    echo "Unknown target: $INPUT_TARGET" && exit 1
fi

bash .github/actions/build.sh