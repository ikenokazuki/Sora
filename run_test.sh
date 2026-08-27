#!/usr/bin/env bash
set -e
# wreq-js (TLSフィンガープリント偽装, Rustネイティブアドオン) はNixOS環境で
# libstdc++.so.6 を標準パスから見つけられないため LD_LIBRARY_PATH を明示する
LIBSTDCXX_PATH=$(nix-build '<nixpkgs>' -A stdenv.cc.cc.lib --no-out-link)
nix-shell -p bun chromium --run "ALLOW_LOCAL_FETCH=true CHROME_PATH=\$(which chromium) LD_LIBRARY_PATH=${LIBSTDCXX_PATH}/lib:\$LD_LIBRARY_PATH bun test --timeout 30000"
