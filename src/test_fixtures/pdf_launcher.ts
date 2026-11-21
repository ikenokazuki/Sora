import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pdfDropProbe, resetPdfDropWarnings } from '../pdf_uid.js';

/**
 * 試験用: root で、起動用バイナリがある環境を作る（strict の PDF の解析は、別の uid に落とせないと失敗するので、strict を試すテストが要る）。
 * 偽の起動用バイナリは、受け取った uid・gid・本物の実行ファイルを記録し、SORA_LAUNCH_* を消して（本物と同じ）、本物の実行ファイルを exec する。
 * uid は落とさない（落ちることの確認は公開イメージ。scripts/pdf-uid-check.ts）。restore() で元に戻す（pdfDropProbe と、作ったファイル）。
 */
export function installFakePdfLauncher(): { launches: () => string[]; reaped: number[]; restore: () => void } {
  const original = { ...pdfDropProbe };
  const dir = mkdtempSync(join(tmpdir(), 'pdf-launcher-'));
  const log = join(dir, 'launch.log');
  const launcher = join(dir, 'launch.sh');
  writeFileSync(launcher, `#!/bin/sh\nexe="$SORA_LAUNCH_EXEC"\nprintf '%s\\n' "uid=$SORA_LAUNCH_UID gid=$SORA_LAUNCH_GID exec=$exe" >> '${log}'\nunset SORA_LAUNCH_EXEC SORA_LAUNCH_UID SORA_LAUNCH_GID\nexec "$exe" "$@"\n`);
  chmodSync(launcher, 0o755);
  const reaped: number[] = [];
  resetPdfDropWarnings();
  pdfDropProbe.currentUid = () => 0;
  pdfDropProbe.launcher = () => launcher;
  pdfDropProbe.launcherExists = () => true;
  pdfDropProbe.missingCapabilities = () => [];
  pdfDropProbe.reap = async (uid) => {
    reaped.push(uid);
    return true;
  };
  return {
    launches: () => {
      try {
        return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
    reaped,
    restore: () => {
      Object.assign(pdfDropProbe, original);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
