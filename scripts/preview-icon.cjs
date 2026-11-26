// 图标各尺寸预览：模拟任务栏/桌面/列表视图的实际观感
// 用法: electron scripts/preview-icon.cjs
// 与 make-icon.cjs 保持一致：小尺寸走 icon-small.svg
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outFile = path.join(root, '.icon-preview.png');

// 每格 128 逻辑像素，按真实像素密度绘制后放大，呈现真实观感
const SIZES = [16, 24, 32, 48, 64, 128];

function dataUrlOf(name) {
  const svg = fs.readFileSync(path.join(root, 'public/assets', name), 'utf8');
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 400, webPreferences: { offscreen: true } });
  await win.loadURL('about:blank');

  const cell = 128;
  const gap = 16;
  const width = cell * SIZES.length + gap * (SIZES.length + 1);
  const height = cell * 2 + gap * 3;

  const script = `(async () => {
    const sizes = ${JSON.stringify(SIZES)};
    const cell = ${cell}, gap = ${gap};
    const urls = ${JSON.stringify(SIZES.map((s) => dataUrlOf(s <= 24 ? 'icon-small.svg' : 'icon.svg')))};

    const c = document.createElement('canvas');
    c.width = ${width}; c.height = ${height};
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    // 上排浅色背景，下排深色背景
    ctx.fillStyle = '#f4f4f7'; ctx.fillRect(0, 0, c.width, cell + gap);
    ctx.fillStyle = '#1e1e24'; ctx.fillRect(0, cell + gap, c.width, c.height - cell - gap);

    const tmp = document.createElement('canvas');
    const tctx = tmp.getContext('2d');
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < sizes.length; i++) {
        const size = sizes[i];
        const img = new Image();
        img.src = urls[i];
        await img.decode();
        tmp.width = size; tmp.height = size;
        tctx.clearRect(0, 0, size, size);
        tctx.drawImage(img, 0, 0, size, size);
        const x = gap + i * (cell + gap) + (cell - size) / 2;
        const y = gap + row * (cell + gap * 2) + (cell - size) / 2;
        ctx.drawImage(tmp, x, y, size, size);
      }
    }
    return c.toDataURL('image/png').split(',')[1];
  })()`;

  const b64 = await win.webContents.executeJavaScript(script);
  fs.writeFileSync(outFile, Buffer.from(b64, 'base64'));
  console.log('预览:', outFile);
  app.quit();
}).catch((e) => { console.error('ERR', e); app.exit(1); });
