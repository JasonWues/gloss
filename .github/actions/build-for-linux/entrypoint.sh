#!/bin/bash

# Node 22, not 19.8.1. `npm install pnpm -g` takes the latest pnpm, and pnpm 11
# refuses to start on anything below Node 22.13 -- so this pairing broke on its
# own the day pnpm 11 shipped, without the file changing.
NODE_VERSION=v22.20.0
# The architecture was `x64` written into the URL, which was true for as long
# as every Linux build ran on an x86_64 runner. aarch64 now builds on its own
# machine, where that tarball downloads happily and then cannot execute.
case "$(uname -m)" in
    x86_64) NODE_ARCH=x64 ;;
    aarch64) NODE_ARCH=arm64 ;;
    *) echo "::error::no Node build known for host $(uname -m)" && exit 1 ;;
esac
wget "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
tar -Jxf "./node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
export PATH=$(pwd)/node-${NODE_VERSION}-linux-${NODE_ARCH}/bin:$PATH
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
# clang is here for bindgen, which libspa-sys runs over the pipewire headers.
BINDGEN_DEPS="clang libclang-dev"

# This script has no `set -e`, so a failed `apt-get install` used to be
# invisible: the packages were silently absent and the build carried on to
# cargo, which died ten or so minutes later inside gdk-sys with "The system
# library `gdk-3.0` was not found" -- an error about pkg-config describing an
# apt problem that had long scrolled off the top of the log. Every
# cross-architecture target had been failing exactly that way.
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

# Both targets are built on their own architecture -- x86_64 on an x86_64
# runner, aarch64 on an ARM one -- so there is one native package list rather
# than a cross-compilation branch each.
#
# The cross branch this replaces could not have been made to work by choosing
# different packages. The GTK -dev stack pulls in gobject-introspection, whose
# python3-mako and python3-markdown dependencies are Architecture:all, and an
# Architecture:all package cannot be installed under a foreign-arch qualifier
# at all -- apt calls it "not installable" rather than missing. Installing
# linux-libc-dev:arm64 alongside also displaced the host's own and broke
# libc6-dev with it.
case "$INPUT_TARGET" in
    x86_64-unknown-linux-gnu | aarch64-unknown-linux-gnu)
        apt-get update
        apt_install libgtk-3-dev libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev xdg-utils patchelf libxdo-dev libxcb1 libxrandr2 libdbus-1-3 libpipewire-0.3-dev libspa-0.2-dev libgbm-dev libdrm-dev libegl-dev $BINDGEN_DEPS
        ;;
    *)
        echo "::error::Unknown target: $INPUT_TARGET" && exit 1
        ;;
esac

bash .github/actions/build.sh