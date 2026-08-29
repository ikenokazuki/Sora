# 孤立した Chromium プロセスの残骸をクリーンアップしてメモリ枯渇・SSH切断を防止
pkill -f "chromium-unwrapped" 2>/dev/null || true

LIBSTDCXX_PATH=$(nix-build '<nixpkgs>' -A stdenv.cc.cc.lib --no-out-link)
nix-shell -p bun chromium --run "ALLOW_LOCAL_FETCH=true CHROME_PATH=\$(which chromium) LD_LIBRARY_PATH=${LIBSTDCXX_PATH}/lib:\$LD_LIBRARY_PATH bun test --timeout 60000"

# テスト完了後のクリーンアップ
pkill -f "chromium-unwrapped" 2>/dev/null || true
