const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  folderName,
  isEmptyFolder,
  resolveProjectRoot,
} = require("../electron/project-location.cjs");

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weave-location-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("空文件夹直接作为项目目录", (t) => {
  const root = workspace(t);
  const picked = path.join(root, "空目录");
  fs.mkdirSync(picked);
  const target = resolveProjectRoot(picked, "宣传片");
  assert.equal(target.root, picked);
  assert.equal(target.subfolder, null);
});

test("文件夹里已有素材时自动新建同名子文件夹", (t) => {
  const root = workspace(t);
  const picked = path.join(root, "素材汇总");
  fs.mkdirSync(picked);
  fs.writeFileSync(path.join(picked, "a.mp4"), "x");
  const target = resolveProjectRoot(picked, "双十一");
  assert.equal(target.subfolder, "双十一");
  assert.equal(target.root, path.join(picked, "双十一"));
  assert.ok(fs.statSync(target.root).isDirectory());
  assert.equal(fs.readFileSync(path.join(picked, "a.mp4"), "utf8"), "x");
});

test("只有隐藏文件也算非空", (t) => {
  const root = workspace(t);
  const picked = path.join(root, "带隐藏文件");
  fs.mkdirSync(picked);
  fs.writeFileSync(path.join(picked, ".DS_Store"), "x");
  assert.equal(isEmptyFolder(picked), false);
  assert.equal(resolveProjectRoot(picked, "项目").subfolder, "项目");
});

test("同名的空子文件夹会被复用，非空的加序号", (t) => {
  const root = workspace(t);
  const picked = path.join(root, "容器");
  fs.mkdirSync(path.join(picked, "拍摄"), { recursive: true });
  const reused = resolveProjectRoot(picked, "拍摄");
  assert.equal(reused.root, path.join(picked, "拍摄"));

  fs.writeFileSync(path.join(picked, "拍摄", "占用.txt"), "x");
  const numbered = resolveProjectRoot(picked, "拍摄");
  assert.equal(numbered.subfolder, "拍摄-2");
  assert.equal(numbered.root, path.join(picked, "拍摄-2"));
});

test("非法字符和保留名会被清理成合法文件夹名", () => {
  assert.equal(folderName('  a/b:c*d?e"f<g>h|i  '), "a b c d e f g h i");
  assert.equal(folderName("结尾有点点..."), "结尾有点点");
  assert.equal(folderName("CON"), "CON_");
  assert.equal(folderName("   "), "未命名项目");
  assert.ok(folderName("长".repeat(120)).length <= 60);
});

test("路径不存在或不是文件夹时给出可读错误", (t) => {
  const root = workspace(t);
  assert.throws(
    () => resolveProjectRoot(path.join(root, "不存在"), "项目"),
    /文件夹不存在/,
  );
  const file = path.join(root, "一个文件.txt");
  fs.writeFileSync(file, "x");
  assert.throws(() => resolveProjectRoot(file, "项目"), /选择一个文件夹/);
});
