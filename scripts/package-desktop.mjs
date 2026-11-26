import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRequire = createRequire(path.join(root, 'electron/main.cjs'));
// 默认输出到 release/；安全软件可能长期占用旧产物导致无法覆盖，
// 此时可用 WEAVE_RELEASE_DIR 指到另一个目录继续打包。
const release = process.env.WEAVE_RELEASE_DIR
  ? path.resolve(root, process.env.WEAVE_RELEASE_DIR)
  : path.join(root, 'release');
// 交付目录与主程序都用中文名，和窗口标题保持一致。
const APP_NAME = '映箱';
const target = path.join(release, APP_NAME);
const marker = '.weave-desktop-package.json';
const stage = path.join(release, `.Weave-build-${randomUUID()}`);
const wantZip = process.argv.includes('--zip');
const versioned = process.argv.includes('--versioned');
const copied = new Map();
const edges = [];

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function requireFile(file) {
  if (!(await fs.stat(file)).isFile()) throw new Error(`缺少文件：${file}`);
}
// Check every ancestor: a junction must never redirect cleanup or output writes.
async function checkPath(file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`不安全的交付路径：${file}`);
  let cursor = file;
  while (cursor !== root) {
    if (await exists(cursor)) {
      if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error(`交付路径不能是链接：${cursor}`);
    }
    cursor = path.dirname(cursor);
  }
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('项目根目录不能是链接。');
}
async function moveIntoPlace(from, to) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      if (attempt === 5) break;
      // 刚写完两千多个文件时，安全软件（DLP/终端管控）还在扫，改名会瞬时被拒。
      await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
    }
  }
  await fs.cp(from, to, { recursive: true });
  console.warn('目录改名被安全软件持续拦截，已改用复制方式落地。');
}
async function removeOutput(directory) {
  if (directory !== target && directory !== stage) throw new Error('拒绝清理未授权目录。');
  await checkPath(directory);
  if (await exists(directory)) {
    const identity = await readJson(path.join(directory, marker));
    if (identity.format !== 'weave-desktop-v1') throw new Error(`拒绝覆盖非 Weave 交付目录：${directory}`);
    try {
      await fs.rm(directory, { recursive: true });
    } catch (error) {
      // 有些环境的安全策略会拦截批量删除。改名搁置同样能腾出路径，
      // 不该因为清理失败就让整个打包前功尽弃。
      const parked = `${directory}.old-${randomUUID().slice(0, 8)}`;
      try {
        await fs.rename(directory, parked);
        console.warn(`无法删除 ${path.basename(directory)}，已改名搁置为 ${path.basename(parked)}`);
        return;
      } catch {
        throw new Error(
          `无法清理旧产物 ${directory}（${error.code || error.message}）。` +
          '该目录可能被安全软件或残留进程占用：请关闭映箱后重试，手动删除该目录，' +
          '或设置 WEAVE_RELEASE_DIR 换一个输出目录（例如 WEAVE_RELEASE_DIR=release-build）。',
        );
      }
    }
  }
}

// Resolve the package directory rather than requiring its entry. This handles
// exports-hidden package.json, import-only ESM packages, and pnpm junctions.
async function packageRoot(name, fromRequire) {
  if (name.startsWith('node:') && isBuiltin(name)) return null;
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error(`无效的依赖名称：${name}`);
  for (const modules of fromRequire.resolve.paths(`${name}/package.json`) ?? []) {
    const candidate = path.join(modules, name);
    if (await exists(path.join(candidate, 'package.json'))) return fs.realpath(candidate);
  }
  // A dependency called process/buffer may be a real npm shim used as
  // require('process/'). Only skip builtins when no package is installed.
  if (isBuiltin(name)) return null;
  const error = new Error(`无法解析运行时依赖 ${name}（${fromRequire.resolve.paths(name)?.[0]}）`);
  error.code = 'MODULE_NOT_FOUND';
  throw error;
}

async function install(name, fromRequire, owner, optional = false) {
  if (name.startsWith('node:') && isBuiltin(name)) return;
  let source;
  try { source = await packageRoot(name, fromRequire); }
  catch (error) {
    if (optional && error.code === 'MODULE_NOT_FOUND') return;
    throw error;
  }
  if (!source) return;
  const localRequire = createRequire(path.join(owner, '__weave_resolution__.cjs'));
  // Reuse an already visible copy only when it came from the same package root.
  for (const modules of localRequire.resolve.paths(`${name}/package.json`) ?? []) {
    const candidate = path.join(modules, name);
    if (copied.has(candidate)) {
      if (copied.get(candidate) === source) {
        edges.push({ owner, name, destination: candidate });
        return;
      }
      break;
    }
  }
  const hoisted = path.join(app, 'node_modules', name);
  const destination = copied.has(hoisted) ? path.join(owner, 'node_modules', name) : hoisted;
  if (copied.has(destination)) throw new Error(`依赖版本冲突：${name} / ${owner}`);
  copied.set(destination, source);
  edges.push({ owner, name, destination });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, {
    recursive: true, dereference: true,
    filter: file => {
      const relative = path.relative(source, file);
      return relative !== 'node_modules' && !relative.startsWith(`node_modules${path.sep}`);
    },
  });
  const manifest = await readJson(path.join(source, 'package.json'));
  const dependencyRequire = createRequire(path.join(source, 'package.json'));
  const optionalDependencies = manifest.optionalDependencies ?? {};
  const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies, ...optionalDependencies };
  for (const dependency of Object.keys(dependencies)) {
    const mayBeAbsent = Object.hasOwn(optionalDependencies, dependency)
      || manifest.peerDependenciesMeta?.[dependency]?.optional === true;
    await install(dependency, dependencyRequire, destination, mayBeAbsent);
  }
}

async function verifyDirectory(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`交付中残留链接：${full}`);
    if (entry.isDirectory()) await verifyDirectory(full);
  }
}
async function zipOutput() {
  const version = (await readJson(path.join(root, 'package.json'))).version;
  if (versioned && !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('无法生成版本化的 Windows ZIP：版本号无效。');
  const zip = path.join(release, versioned ? `Weave-Windows-v${version}.zip` : 'Weave-Windows.zip');
  const temporary = path.join(release, `.Weave-${randomUUID()}.zip`);
  await checkPath(zip);
  if (await exists(zip)) throw new Error(`ZIP 已存在，请先移动或删除后重新运行：${zip}`);
  const archiver = sourceRequire('archiver');
  const { createWriteStream } = await import('node:fs');
  try {
    await new Promise((resolve, reject) => {
      const output = createWriteStream(temporary, { flags: 'wx' });
      const archive = archiver('zip', { zlib: { level: 6 } });
      const fail = error => { archive.abort(); output.destroy(); reject(error); };
      output.once('close', resolve);
      output.once('error', fail);
      archive.once('error', fail);
      archive.on('warning', fail);
      archive.pipe(output);
      archive.directory(target, APP_NAME);
      archive.finalize().catch(fail);
    });
    await fs.rename(temporary, zip);
    console.log(`便携压缩包：${zip}`);
  } finally {
    if (await exists(temporary)) await fs.unlink(temporary);
  }
}

// 程序本体收进「程序」子目录：交付目录外层只留启动入口和说明，
// 不带 dll/pak/资源目录，非技术用户也能一眼看懂该点哪个。
const program = path.join(stage, '程序');
const app = path.join(program, 'resources/app');
try {
  if (process.platform !== 'win32') throw new Error('此脚本用于 Windows Electron 运行时。');
  for (const file of ['electron/main.cjs', 'electron/preload.cjs', 'shared/editing.mjs', 'dist/client/index.html', 'node_modules/electron/dist/electron.exe']) {
    await requireFile(path.join(root, file));
  }
  const electronPackage = await readJson(path.join(root, 'node_modules/electron/package.json'));
  const runtimeVersion = (await fs.readFile(path.join(root, 'node_modules/electron/dist/version'), 'utf8')).trim().replace(/^v/, '');
  if (runtimeVersion !== electronPackage.version) {
    throw new Error(`Electron 运行时 ${runtimeVersion} 与已安装包 ${electronPackage.version} 不一致，请先完成 electron/install.js。`);
  }
  await checkPath(stage);
  await checkPath(target);
  if (await exists(target)) {
    const identity = await readJson(path.join(target, marker));
    if (identity.format !== 'weave-desktop-v1') throw new Error(`${path.relative(root, target)} 不是此脚本生成的目录，拒绝覆盖。`);
  }
  await fs.mkdir(stage, { recursive: true });
  await fs.writeFile(path.join(stage, marker), JSON.stringify({ format: 'weave-desktop-v1', electron: runtimeVersion }));
  // 界面只用得到中英双语；其余 51 个语言包约 45 MB，复制时就排除，
  // 避免先复制再删除（批量删除在企业管控环境里可能被安全策略拦截）。
  const KEEP_LOCALES = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak']);
  const distDir = path.join(root, 'node_modules/electron/dist');
  await fs.cp(distDir, program, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const parts = path.relative(distDir, src).split(path.sep);
      if (parts[0] === 'locales' && parts.length === 2) return KEEP_LOCALES.has(parts[1]);
      return true;
    },
  });
  await fs.rename(path.join(program, 'electron.exe'), path.join(program, `${APP_NAME}.exe`));
  // app wins over Electron's bundled default_app.asar when resources/app exists.
  await fs.mkdir(app, { recursive: true });
  const project = await readJson(path.join(root, 'package.json'));
  // name/productName 刻意保持 weave/Weave：Electron 用它推导 userData 目录
  // （%APPDATA%\Weave）。改成中文会让老用户的素材库索引凭空“消失”，
  // 而中文名已经体现在 exe 文件名和窗口标题上，这里不需要同步。
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({
    name: 'weave', productName: 'Weave', version: project.version,
    private: true, type: 'module', main: 'electron/main.cjs',
  }, null, 2));
  // 资源管理器/任务栏读的是 exe 的 PE 资源，不写进去就一直是 Electron 默认图标
  const embed = spawnSync(
    process.execPath,
    [path.join(root, 'scripts/embed-icon.mjs'), path.join(program, `${APP_NAME}.exe`), path.join(root, 'electron/assets/icon.ico'), project.version],
    { encoding: 'utf8' },
  );
  if (embed.status !== 0) throw new Error(`写入 exe 图标失败：${embed.stderr?.trim() || embed.stdout?.trim()}`);
  await fs.cp(path.join(root, 'electron'), path.join(app, 'electron'), { recursive: true, dereference: true });
  await fs.cp(path.join(root, 'shared'), path.join(app, 'shared'), { recursive: true, dereference: true });
  await fs.cp(path.join(root, 'dist/client'), path.join(app, 'dist/client'), { recursive: true, dereference: true });
  await fs.copyFile(path.join(root, '使用说明.txt'), path.join(stage, '使用说明.txt'));
  for (const name of ['archiver', 'chokidar']) await install(name, sourceRequire, app);
  // Verify every edge using the delivered layout, with no reliance on pnpm links.
  for (const edge of edges) {
    const delivered = await packageRoot(edge.name, createRequire(path.join(edge.owner, '__weave_resolution__.cjs')));
    if (delivered !== await fs.realpath(edge.destination)) throw new Error(`交付依赖解析错误：${edge.name}`);
  }
  for (const file of [`程序/${APP_NAME}.exe`, '程序/resources/app/package.json', '程序/resources/app/electron/main.cjs', '程序/resources/app/electron/preload.cjs', '程序/resources/app/electron/assets/icon.png', '程序/resources/app/electron/assets/icon.ico', '程序/resources/app/dist/client/index.html', '程序/resources/app/node_modules/archiver/package.json', '程序/resources/app/node_modules/chokidar/package.json', '使用说明.txt']) {
    await requireFile(path.join(stage, file));
  }
  const deliveredRequire = createRequire(path.join(app, 'electron/main.cjs'));
  deliveredRequire('archiver');
  deliveredRequire('chokidar');
  await verifyDirectory(stage);
  await removeOutput(target);
  await moveIntoPlace(stage, target);
  // 外层生成「映箱」「映箱-公司」两个启动入口，并把校验标记设为隐藏，
  // 交付目录打开后只有快捷方式和说明，非技术用户不会点错。
  const launchers = spawnSync(process.execPath, [path.join(root, 'scripts/make-launchers.mjs'), target], { encoding: 'utf8' });
  if (launchers.status !== 0) console.warn(`快捷方式生成失败：${launchers.stderr?.trim()}`);
  spawnSync('cmd', ['/c', 'attrib', '+h', path.join(target, marker)], { stdio: 'ignore' });
  console.log(`已打包并验证 ${copied.size} 个运行时依赖目录：${target}`);
  console.log('接收方无需安装 Node/npm；双击 映箱.exe 启动。');
  if (wantZip) await zipOutput();
} catch (error) {
  console.error(`打包失败：${error.message}`);
  process.exitCode = 1;
} finally {
  try {
    if (await exists(stage)) await removeOutput(stage);
  } catch {
    console.warn(`临时目录未能清理，可稍后手动删除：${stage}`);
  }
}
