// 在交付目录外层生成启动快捷方式（含公司兼容模式）
// 用法: node scripts/make-launchers.mjs "<目录>"
// 例:   node scripts/make-launchers.mjs "D:\\Desktop\\映箱"
//
// 用 WScript.Shell 而不是自己 P/Invoke IShellLink：后者生成的 .lnk
// 属性读起来正确，但 ShellExecute 执行时目标解析不出来（实测），
// 只有前者产出的文件是资源管理器真正认的。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const APP_NAME = '映箱';
const EXE = `${APP_NAME}.exe`;

// 企业电脑上常见的启动失败原因，逐条对应的开关见 使用说明.txt
const COMPAT_FLAGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-features=RendererCodeIntegrity,NetworkServiceSandbox',
].join(' ');

const target = path.resolve(process.argv[2] || '');
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  console.error(`目标目录不存在：${target}`);
  process.exit(1);
}

// 程序本体在「程序」子目录；也兼容旧版把 exe 摊在外层的结构
const programDir = [path.join(target, '程序'), target]
  .find((dir) => fs.existsSync(path.join(dir, EXE)));
if (!programDir) {
  console.error(`目标目录里找不到 ${EXE}：${target}`);
  process.exit(1);
}
const exePath = path.join(programDir, EXE);

function makeShortcut(fileName, args, description) {
  const lnk = path.join(target, fileName);
  if (fs.existsSync(lnk)) fs.rmSync(lnk, { force: true });

  // PowerShell 单引号字符串不做变量展开，路径只要不含单引号就安全
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$sc = $ws.CreateShortcut(${quote(lnk)})`,
    `$sc.TargetPath = ${quote(exePath)}`,
    `$sc.Arguments = ${quote(args)}`,
    `$sc.WorkingDirectory = ${quote(programDir)}`,
    `$sc.IconLocation = ${quote(`${exePath},0`)}`,
    `$sc.Description = ${quote(description)}`,
    '$sc.WindowStyle = 1',
    '$sc.Save()',
  ].join('\n');

  // -EncodedCommand 走 UTF-16LE base64，绕开 PS 5.1 按 GBK 解码 .ps1 的坑
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `创建 ${fileName} 失败`);
  }
  if (!fs.existsSync(lnk)) throw new Error(`${fileName} 未生成`);
  return lnk;
}

try {
  makeShortcut(`${APP_NAME}.lnk`, '', `${APP_NAME} · 视频创作工作台`);
  makeShortcut(`${APP_NAME}-公司.lnk`, COMPAT_FLAGS, `${APP_NAME} · 公司兼容模式`);
  console.log(`已生成：${APP_NAME}.lnk、${APP_NAME}-公司.lnk`);
} catch (error) {
  console.error(`生成快捷方式失败：${error.message}`);
  process.exitCode = 1;
}
