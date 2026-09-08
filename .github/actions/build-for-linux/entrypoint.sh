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

if [ "$INPUT_TARGET" = "x86_64-unknown-linux-gnu" ]; then
    apt-get update
    apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev xdg-utils patchelf libxdo-dev libxcb1 libxrandr2 libdbus-1-3 libpipewire-0.3-dev libspa-0.2-dev libgbm-dev libdrm-dev libegl-dev $BINDGEN_DEPS
elif [ "$INPUT_TARGET" = "i686-unknown-linux-gnu" ]; then
    dpkg --add-architecture i386
    apt-get update
    apt-get install -y libstdc++6:i386 libgdk-pixbuf2.0-dev:i386 libatomic1:i386 gcc-multilib g++-multilib libwebkit2gtk-4.1-dev:i386 libjavascriptcoregtk-4.1-dev:i386 libsoup-3.0-dev:i386 libssl-dev:i386 libgtk-3-dev:i386 librsvg2-dev:i386 xdg-utils patchelf:i386 libxdo-dev:i386 libxcb1:i386 libxrandr2:i386 libdbus-1-3:i386 libayatana-appindicator3-dev:i386 libpipewire-0.3-dev:i386 libspa-0.2-dev:i386 libgbm-dev:i386 libdrm-dev:i386 libegl-dev:i386 $BINDGEN_DEPS
    export PKG_CONFIG_PATH=/usr/lib/i386-linux-gnu/pkgconfig/:$PKG_CONFIG_PATH
    export PKG_CONFIG_SYSROOT_DIR=/
    # libspa-sys' build.rs never passes --target to clang, so bindgen would parse
    # the i386 headers with host (x86_64) type sizes. Point it at the target.
    export BINDGEN_EXTRA_CLANG_ARGS="--target=i686-linux-gnu -I/usr/include/i386-linux-gnu"
elif [ "$INPUT_TARGET" = "aarch64-unknown-linux-gnu" ]; then
    dpkg --add-architecture arm64
    apt-get update
    apt-get install -y libncurses6:arm64 libtinfo6:arm64 linux-libc-dev:arm64 libncursesw6:arm64 libcups2:arm64
    apt-get install -y --no-install-recommends g++-aarch64-linux-gnu libc6-dev-arm64-cross libssl-dev:arm64 libwebkit2gtk-4.1-dev:arm64 libjavascriptcoregtk-4.1-dev:arm64 libsoup-3.0-dev:arm64 libgtk-3-dev:arm64 patchelf:arm64 xdg-utils librsvg2-dev:arm64 libxdo-dev:arm64 libxcb1:arm64 libxrandr2:arm64 libdbus-1-3:arm64 libayatana-appindicator3-dev:arm64 libpipewire-0.3-dev:arm64 libspa-0.2-dev:arm64 libgbm-dev:arm64 libdrm-dev:arm64 libegl-dev:arm64 $BINDGEN_DEPS
    export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
    export CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc
    export CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++
    export PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig
    export PKG_CONFIG_ALLOW_CROSS=1
    # See the i386 branch: bindgen needs the target spelled out, or libspa-sys
    # gets bindings sized for the host.
    export BINDGEN_EXTRA_CLANG_ARGS="--target=aarch64-linux-gnu -I/usr/include/aarch64-linux-gnu"
elif [ "$INPUT_TARGET" = "armv7-unknown-linux-gnueabihf" ]; then
    dpkg --add-architecture armhf
    apt-get update
    apt-get install -y libncurses6:armhf libtinfo6:armhf linux-libc-dev:armhf libncursesw6:armhf libcups2:armhf
    apt-get install -y --no-install-recommends g++-arm-linux-gnueabihf libc6-dev-armhf-cross libssl-dev:armhf libwebkit2gtk-4.1-dev:armhf libjavascriptcoregtk-4.1-dev:armhf libsoup-3.0-dev:armhf libgtk-3-dev:armhf patchelf:armhf librsvg2-dev:armhf libxdo-dev:armhf libxcb1:armhf libxrandr2:armhf libdbus-1-3:armhf libayatana-appindicator3-dev:armhf libpipewire-0.3-dev:armhf libspa-0.2-dev:armhf libgbm-dev:armhf libdrm-dev:armhf libegl-dev:armhf $BINDGEN_DEPS
    export CARGO_TARGET_ARMV7_UNKNOWN_LINUX_GNUEABIHF_LINKER=arm-linux-gnueabihf-gcc
    export CC_armv7_unknown_linux_gnueabihf=arm-linux-gnueabihf-gcc
    export CXX_armv7_unknown_linux_gnueabihf=arm-linux-gnueabihf-g++
    export PKG_CONFIG_PATH=/usr/lib/arm-linux-gnueabihf/pkgconfig
    export PKG_CONFIG_ALLOW_CROSS=1
    # See the i386 branch: bindgen needs the target spelled out, or libspa-sys
    # gets bindings sized for the host.
    export BINDGEN_EXTRA_CLANG_ARGS="--target=arm-linux-gnueabihf -I/usr/include/arm-linux-gnueabihf"
else
    echo "Unknown target: $INPUT_TARGET" && exit 1
fi

bash .github/actions/build.sh