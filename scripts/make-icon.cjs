// 从 public/assets/icon.svg 生成多尺寸 PNG 与 Windows .ico
// 用法: electron scripts/make-icon.cjs
// 16/24/32 使用 icon-small.svg：去掉层叠、时间轴等细节并放大主体，
// 否则主卡片在 16px 下只剩 8px 宽，播放三角会糊成一个色块。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'electron/assets');

const FULL_SIZES = [32, 48, 64, 128, 256, 512];
const SMALL_SIZES = [16, 24];

function buildIco(pngs) {
  // ICO 容器直接内嵌 PNG（Windows Vista 及以上支持）
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();

async function render(win, svgPath, sizes) {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const script = `(async () => {
    const sizes = ${JSON.stringify(sizes)};
    const img = new Image();
    img.src = ${JSON.stringify(dataUrl)};
    await img.decode();
    const out = {};
    for (const size of sizes) {
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      out[size] = c.toDataURL('image/png').split(',')[1];
    }
    return out;
  })()`;
  return win.webContents.executeJavaScript(script);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 600, webPreferences: { offscreen: true } });
  await win.loadURL('about:blank');

  const full = await render(win, path.join(root, 'public/assets/icon.svg'), FULL_SIZES);
  const small = await render(win, path.join(root, 'public/assets/icon-small.svg'), SMALL_SIZES);

  fs.mkdirSync(outDir, { recursive: true });
  const pngs = [];
  const save = (size, base64) => {
    const data = Buffer.from(base64, 'base64');
    pngs.push({ size, data });
    if (size === 512) fs.writeFileSync(path.join(outDir, 'icon.png'), data);
    if (size === 256) fs.writeFileSync(path.join(outDir, 'icon-256.png'), data);
  };
  SMALL_SIZES.forEach((size) => save(size, small[size]));
  FULL_SIZES.forEach((size) => save(size, full[size]));

  fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(pngs));
  console.log('生成完成:', pngs.map((p) => `${p.size}(${p.data.length}B)`).join(' '));
  console.log('输出目录:', outDir);
  app.quit();
}).catch((e) => { console.error('ERR', e); app.exit(1); });
