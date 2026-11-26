// 把 icon.ico 和版本信息写进 exe 的 PE 资源段
// 用法: node scripts/embed-icon.mjs <exe路径> <ico路径> [版本号]
//
// 只改运行时图标（窗口/托盘）是不够的：资源管理器、桌面、任务栏显示的
// 是 exe 文件自身 PE 资源里的图标，不写进去就一直是 Electron 默认的原子球。
import fs from 'node:fs';
import path from 'node:path';
import * as ResEdit from 'resedit';

const RT_GROUP_ICON = 14;

const [exePath, icoPath, version = '0.3.1'] = process.argv.slice(2);
if (!exePath || !icoPath) {
  console.error('用法: node scripts/embed-icon.mjs <exe> <ico> [版本号]');
  process.exit(1);
}
if (!fs.existsSync(exePath)) throw new Error(`找不到 exe：${exePath}`);
if (!fs.existsSync(icoPath)) throw new Error(`找不到 ico：${icoPath}`);

const appName = path.basename(exePath, path.extname(exePath));

const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);

// 图标：替换所有已有的图标组；没有的话新建一个
const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
const icons = iconFile.icons.map((icon) => icon.data);
const groups = res.entries.filter((entry) => entry.type === RT_GROUP_ICON);
if (groups.length === 0) {
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icons);
} else {
  for (const group of groups) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries, group.id, group.lang, icons,
    );
  }
}

// 版本信息：任务管理器、文件属性、任务栏提示都读这里
const [major, minor, patch] = version.split('.').map((n) => Number.parseInt(n, 10) || 0);
const versionInfos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
if (versionInfos.length > 0) {
  const info = versionInfos[0];
  info.setFileVersion(major, minor, patch, 0);
  info.setProductVersion(major, minor, patch, 0);
  for (const { lang, codepage } of info.getAllLanguagesForStringValues()) {
    info.setStringValues({ lang, codepage }, {
      ProductName: appName,
      FileDescription: `${appName} · 视频创作工作台`,
      InternalName: appName,
      OriginalFilename: path.basename(exePath),
      CompanyName: appName,
      LegalCopyright: '',
    });
  }
  info.outputToResourceEntries(res.entries);
}

res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log(`已写入图标与版本信息：${path.basename(exePath)}（${(fs.statSync(exePath).size / 1048576).toFixed(0)} MB）`);
