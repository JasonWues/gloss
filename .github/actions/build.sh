# pnpm install --resolution-only
pnpm install
sed -i "s/#openssl/openssl={version=\"0.10\",features=[\"vendored\"]}/g" src-tauri/Cargo.toml
# One command for both targets. This used to hand everything but x86_64 a
# `-b deb rpm`, because a cross-compiled AppImage cannot be built: the bundler
# runs the target's own binaries to assemble it. Both Linux targets are native
# now, so aarch64 gets an AppImage too -- which the updater manifest has been
# pointing at since the Linux entries were corrected.
pnpm tauri build --target $INPUT_TARGET
