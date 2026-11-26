// 把源码的最新状态同步到桌面上可双击的「映箱」。
//
// 主路径是「增量更新」：只重建前端，再把 dist / electron / shared 以及运行期
// 依赖里有变化的文件覆盖到桌面的 resources/app 里。几百 KB 到几 MB，
// 不需要重新复制 360MB 的 Electron 运行时，也不会撞上安全软件的批量删除拦截。
//
// 桌面那份不存在（或依赖清单变了）时才走完整打包。
//
// 用法：node scripts/ship-desktop.mjs [目标目录]
//   默认目标 D:\Desktop\映箱，也可用 WEAVE_SHIP_TARGET 覆盖。
//   加 --full 强制完整重打包。
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(process.argv.find((arg) => arg.startsWith('--target='))?.slice(9)
  || process.env.WEAVE_SHIP_TARGET
  || 'D:\\Desktop\\映箱');
const forceFull = process.argv.includes('--full');
const appDir = path.join(target, '程序', 'resources', 'app');
const markerFile = path.join(target, '.weave-desktop-package.json');

// 每次改代码一定会变的部分；node_modules 单独按「已存在的文件」增量覆盖。
const MIRROR = [
  ['dist/client', 'dist/client'],
  ['electron', 'electron'],
  ['shared', 'shared'],
];

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function copyRetry(from, to) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await fs.copyFile(from, to);
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES', 'EMFILE'].includes(error.code) || attempt === 6) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

function isRunning() {
  const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq 映箱.exe', '/NH'], { encoding: 'utf8' });
  return (result.stdout || '').includes('映箱.exe');
}

function run(label, args, env = {}) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) {
    console.error(`\n[失败] ${label}（退出码 ${result.status ?? 'null'}）`);
    process.exit(result.status ?? 1);
  }
}

async function walk(dir, base = dir, out = []) {
  if (!(await exists(dir))) return out;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

// 返回 [更新数, 跳过数]
async function syncTree(fromDir, toDir) {
  if (!(await exists(fromDir))) return [0, 0];
  let copied = 0;
  let skipped = 0;
  for (const relative of await walk(fromDir)) {
    const from = path.join(fromDir, relative);
    const to = path.join(toDir, relative);
    await fs.mkdir(path.dirname(to), { recursive: true });
    const [src, dst] = await Promise.all([fs.stat(from), fs.stat(to).catch(() => null)]);
    if (dst && dst.size === src.size && dst.mtimeMs >= src.mtimeMs) { skipped += 1; continue; }
    await copyRetry(from, to);
    copied += 1;
  }
  return [copied, skipped];
}

// 前端产物文件名带内容哈希，构建后会留下旧文件；数量很小，直接清掉。
// 只在 dist/client 内部比较，绝不碰同级的其它内容。
async function pruneStale(fromDir, toDir) {
  const keep = new Set(await walk(fromDir));
  let removed = 0;
  for (const relative of await walk(toDir)) {
    if (keep.has(relative)) continue;
    await fs.rm(path.join(toDir, relative), { force: true });
    removed += 1;
  }
  return removed;
}

// 早期版本曾把前端拷到 dist 根，会留下 app/dist/assets、app/dist/index.html
// 这类错位副本。目录里只允许有 client，其余直接清掉避免混淆。
async function cleanMisplacedDist() {
  const distDir = path.join(appDir, 'dist');
  if (!(await exists(distDir))) return 0;
  let removed = 0;
  for (const entry of await fs.readdir(distDir, { withFileTypes: true })) {
    if (entry.name === 'client') continue;
    await fs.rm(path.join(distDir, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

// 运行期依赖：只覆盖桌面包里已存在的文件，绝不新增或删除条目，
// 这样既不会把开发依赖塞进成品，也不会破坏依赖树。
async function syncRuntimeModules() {
  const toDir = path.join(appDir, 'node_modules');
  let copied = 0;
  let skipped = 0;
  for (const relative of await walk(toDir)) {
    const from = path.join(root, 'node_modules', relative);
    const to = path.join(toDir, relative);
    if (!(await exists(from))) continue;
    const [src, dst] = await Promise.all([fs.stat(from), fs.stat(to)]);
    if (dst.size === src.size && dst.mtimeMs >= src.mtimeMs) { skipped += 1; continue; }
    await copyRetry(from, to);
    copied += 1;
  }
  return [copied, skipped];
}

async function fullPackage() {
  const releaseDir = 'build-out';
  console.log('› 完整打包（首次或依赖变化时才会走这一步）…');
  run('打包', [path.join(root, 'scripts', 'package-desktop.mjs')], { WEAVE_RELEASE_DIR: releaseDir });
  const stage = path.join(root, releaseDir, '映箱');
  await fs.mkdir(target, { recursive: true });
  const [copied, skipped] = await syncTree(stage, target);
  console.log(`  交付目录：更新 ${copied} 个，未变 ${skipped} 个`);
}

if (isRunning()) {
  console.log('提示：检测到「映箱」正在运行，程序文件可能被占用。建议先退出再继续。\n');
}

console.log('› 构建前端与桌面端脚本…');
run('构建', [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']);

if (forceFull || !(await exists(markerFile)) || !(await exists(appDir))) {
  await fullPackage();
} else {
  let updated = 0;
  let skipped = 0;
  for (const [from, to] of MIRROR) {
    const [copied, same] = await syncTree(path.join(root, from), path.join(appDir, to));
    updated += copied;
    skipped += same;
  }
  const [modCopied, modSkipped] = await syncRuntimeModules();
  updated += modCopied;
  skipped += modSkipped;
  const removed = await pruneStale(path.join(root, 'dist/client'), path.join(appDir, 'dist/client'))
    + await cleanMisplacedDist();
  console.log(`\n完成：更新 ${updated} 个文件，未变 ${skipped} 个，清掉旧产物 ${removed} 个。`);
  console.log(`桌面位置：${target}`);
  if (updated === 0) console.log('桌面上那份已经是最新，无需重启。');
  else console.log('重新双击桌面上的「映箱」即可用上新版本。');
}
