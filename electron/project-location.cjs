const fs = require("node:fs");
const path = require("node:path");

// Windows 不允许出现在文件夹名里的字符，外加控制字符。
const ILLEGAL = /[\u0000-\u001f<>:"/\\|?*]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_NAME = 60;

function folderName(name, fallback = "未命名项目") {
  let base = String(name ?? "")
    .replace(ILLEGAL, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/, "")
    .trim();
  if (!base) base = fallback;
  if (RESERVED.test(base)) base = `${base}_`;
  base = base.slice(0, MAX_NAME).replace(/[. ]+$/, "").trim();
  return base || fallback;
}

function isEmptyFolder(dir) {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

/**
 * 把「用户选的文件夹」解析成真正能存项目的目录。
 *
 * 用户选中的文件夹本身是空的就直接用；如果里面已经有东西（素材、其他文件、
 * 隐藏文件都算），就在里面建一个以项目名命名的子文件夹，而不是报错让流程卡死。
 * 同名子文件夹已存在且为空时复用它，非空则依次尝试 `名称-2`、`名称-3`。
 */
function resolveProjectRoot(picked, name) {
  if (!picked) throw new Error("没有选择保存位置。");
  const folder = path.resolve(String(picked));
  let stat;
  try {
    stat = fs.statSync(folder);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("选择的文件夹不存在，请重新选择。");
    throw error;
  }
  if (!stat.isDirectory()) throw new Error("请选择一个文件夹，而不是文件。");
  if (isEmptyFolder(folder)) return { root: folder, subfolder: null };

  const base = folderName(name);
  for (let index = 1; index <= 99; index += 1) {
    const candidate = path.join(folder, index === 1 ? base : `${base}-${index}`);
    if (!isEmptyFolder(candidate)) continue;
    fs.mkdirSync(candidate, { recursive: true });
    return { root: candidate, subfolder: path.basename(candidate) };
  }
  throw new Error(`「${base}」在这个位置已经占了 99 个文件夹，请换一个位置。`);
}

module.exports = { folderName, isEmptyFolder, resolveProjectRoot };
