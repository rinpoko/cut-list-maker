'use strict';
/**
 * Apple の開発者証明書を使わない代わりに、アプリ全体を ad-hoc 署名する。
 *
 * 同梱した ffmpeg や Python(PyInstaller) の実行ファイルまで含めて署名しておかないと、
 * Apple Silicon で「壊れているため開けません」になることがあるため。
 */

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    context.packager.appInfo.productFilename + '.app'
  );

  console.log('  • ad-hoc 署名  ' + appPath);
  execFileSync('/usr/bin/codesign', [
    '--force', '--deep', '--sign', '-',
    '--timestamp=none',
    appPath,
  ], { stdio: 'inherit' });

  execFileSync('/usr/bin/codesign', ['--verify', '--strict', appPath], { stdio: 'inherit' });
};
