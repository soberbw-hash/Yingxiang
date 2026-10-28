const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  shell,
  Notification,
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { Readable } = require("node:stream");
const chokidar = require("chokidar");
const { ProjectRepository, atomic } = require("./project-repository.cjs");
const { fetchRemote } = require("./fetch-remote.cjs");
const { InboxReceipts, overlap } = require("./inbox-receipts.cjs");
const { applicationMenuTemplate } = require("./application-menu.cjs");
const { checkLatestRelease, downloadRelease } = require("./update-service.cjs");
const smokeReport = process.argv
  .find((a) => a.startsWith("--weave-smoke="))
  ?.slice("--weave-smoke=".length);
const smokeRoot = smokeReport
  ? fs.mkdtempSync(path.join(os.tmpdir(), "weave-smoke-"))
  : undefined;
if (smokeRoot) app.setPath("userData", path.join(smokeRoot, "userData"));
app.setAppUserModelId("Weave");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "weave-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);
const METHODS = new Set([
  "saveCanvas",
  "editAssetStack",
  "editReference",
  "bootstrap",
  "createProject",
  "openProject",
  "selectProject",
  "listProjectBackups",
  "createProjectBackup",
  "restoreProjectBackup",
  "importFiles",
  "pickFiles",
  "transferAssets",
  "updateAssets",
  "trashAssets",
  "restoreAssets",
  "createShot",
  "updateShot",
  "deleteShot",
  "saveSettings",
  "chooseInbox",
  "exportProject",
  "revealAsset",
  "readDocument",
  "fetchRemote",
]);
const MUTATIONS = new Set([
  "saveCanvas",
  "editAssetStack",
  "editReference",
  "createProject",
  "openProject",
  "selectProject",
  "importFiles",
  "pickFiles",
  "transferAssets",
  "updateAssets",
  "trashAssets",
  "restoreAssets",
  "createShot",
  "updateShot",
  "deleteShot",
  "saveSettings",
  "chooseInbox",
  "exportProject",
  "createProjectBackup",
  "restoreProjectBackup",
]);
let repo,
  receipts,
  mainWindow,
  inboxWatcher,
  projectWatcher,
  tray,
  poll,
  timer,
  inboxTimer;
const inboxQueue = new Set();
const inboxErrors = new Map();
let watcherKey = "",
  quitting = false,
  rendererReady = false,
  fingerprint = "",
  pending = Promise.resolve();
const notified = new Set();
const DEV_URL = process.env.WEAVE_DEV_URL || "http://127.0.0.1:4173";
const localFile = path.join(__dirname, "../dist/client/index.html");
const production =
  app.isPackaged || !!smokeReport || process.env.WEAVE_FORCE_PRODUCTION === "1";
function trusted(event) {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame
  )
    throw new Error("Untrusted IPC sender");
  const url = new URL(event.senderFrame.url);
  if (
    production
      ? url.href.split("#")[0] !== pathToFileURL(localFile).href
      : url.origin !== new URL(DEV_URL).origin
  )
    throw new Error("Untrusted renderer origin");
}
function emit(reason, snapshot, details = {}) {
  if (rendererReady && mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send("weave:changed", {
      reason,
      projectId: snapshot?.project.id,
      snapshot,
      ...details,
    });
}
function emitUpdate(status) {
  if (rendererReady && mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send("weave:update", status);
}
async function checkAndDownloadUpdate() {
  if (!app.isPackaged || process.platform !== "win32") return;
  try {
    emitUpdate({ state: "checking" });
    const cacheFile = path.join(app.getPath("userData"), "update-check.json");
    let update;
    try {
      const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (Date.now() - cache.checkedAt < 12 * 60 * 60 * 1000 && cache.currentVersion === app.getVersion())
        update = cache.update;
    } catch {}
    if (!update) {
      update = await checkLatestRelease({ currentVersion: app.getVersion() });
      fs.writeFileSync(cacheFile, JSON.stringify({ checkedAt: Date.now(), currentVersion: app.getVersion(), update }));
    }
    if (!update.available) {
      emitUpdate({ state: "current", currentVersion: update.currentVersion });
      return;
    }
    emitUpdate({ state: "downloading", version: update.version, size: update.size });
    const result = await downloadRelease({ update, downloadsPath: app.getPath("downloads") });
    emitUpdate({ state: "downloaded", version: update.version, ...result });
  } catch (error) {
    emitUpdate({ state: "error", message: error.message || "自动检查更新失败" });
  }
}
function digest(snapshot) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
}
function notify(snapshot) {
  const settings = repo.settings();
  const cutoff = settings.lastSeen?.[snapshot.project.id] || "";
  const fresh = snapshot.activities.filter(
    (a) =>
      a.deviceId !== repo.deviceId &&
      a.createdAt > cutoff &&
      !notified.has(a.id),
  );
  fresh.forEach((a) => notified.add(a.id));
  if (
    fresh.length &&
    settings.notifications &&
    !settings.mutedProjects?.includes(snapshot.project.id) &&
    Notification.isSupported()
  ) {
    const notice = new Notification({
      title: `映箱 · ${snapshot.project.name}`,
      body: `${fresh.length} 条项目更新 · ${fresh[fresh.length - 1].actor}`,
    });
    notice.on("click", () => {
      try {
        repo.selectProject({ id: snapshot.project.id });
        createOrShow();
        refreshWatchers();
        emit("notification", repo.snapshot(snapshot.project.id));
      } catch (e) {
        console.warn(e.message);
      }
    });
    notice.show();
  }
}
function scanProjects() {
  const activeProjectId = repo.registry().activeProjectId;
  for (const p of repo.listProjects()) {
    if (p.unavailable) {
      if (p.id === activeProjectId && fingerprint !== "unavailable") {
        fingerprint = "unavailable";
        emit("project.unavailable");
      }
      continue;
    }
    try {
      const snapshot = repo.snapshot(p.id);
      notify(snapshot);
      if (p.id === repo.registry().activeProjectId) {
        const next = digest(snapshot);
        if (next !== fingerprint) {
          fingerprint = next;
          emit("project.changed", snapshot);
        }
      }
    } catch (e) {
      if (e.code !== "BUSY") console.warn("Project rescan:", e.message);
    }
  }
}
function scheduleScan() {
  clearTimeout(timer);
  timer = setTimeout(scanProjects, 350);
}
function ingestInbox() {
  for (const file of [...inboxQueue]) {
    try {
      const snapshot = receipts.receive(file);
      inboxQueue.delete(file);
      inboxErrors.delete(file);
      if (snapshot) emit("inbox.imported", snapshot);
    } catch (e) {
      if (e.code !== "BUSY" && e.code !== "SOURCE_CHANGED") {
        const retryable =
          fs.existsSync(file) &&
          !["INVALID", "TOO_LARGE", "UNSUPPORTED"].includes(e.code);
        if (!retryable) inboxQueue.delete(file);
        if (
          (e.code !== "ENOENT" || retryable) &&
          inboxErrors.get(file) !== e.message
        ) {
          inboxErrors.set(file, e.message);
          emit("inbox.error", undefined, {
            message: retryable
              ? "自动接收暂未完成，请检查项目和接收目录是否可访问。原文件没有删除，软件将自动重试。"
              : `自动接收失败：${e.message}。原文件没有删除。`,
          });
          console.warn(e.message);
        }
      }
    }
  }
  if (inboxQueue.size) {
    clearTimeout(inboxTimer);
    inboxTimer = setTimeout(ingestInbox, 10000);
  }
}
function scheduleInbox(file) {
  if (typeof file === "string") inboxQueue.add(file);
  clearTimeout(inboxTimer);
  inboxTimer = setTimeout(ingestInbox, 650);
}
async function refreshWatchers() {
  const s = repo.settings();
  const projects = repo.listProjects().filter((p) => !p.unavailable);
  const key = JSON.stringify([
    s.inboxPath,
    s.receiveProjectId,
    s.receiveShotId,
    projects.map((p) => [p.id, p.root]),
    repo.registry().activeProjectId,
  ]);
  if (key !== watcherKey) {
    watcherKey = key;
    await inboxWatcher?.close();
    await projectWatcher?.close();
    inboxWatcher = undefined;
    inboxQueue.clear();
    inboxErrors.clear();
    if (s.inboxPath && fs.existsSync(s.inboxPath)) {
      receipts.validate(s.inboxPath);
      inboxWatcher = chokidar.watch(s.inboxPath, {
        ignoreInitial: false,
        followSymlinks: false,
        awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
      });
      inboxWatcher
        .on("add", scheduleInbox)
        .on("change", scheduleInbox)
        .on("error", (e) => console.warn("Inbox watcher:", e.message));
    }
    projectWatcher = chokidar.watch(
      projects.flatMap((p) =>
        ["weave.project.json", "metadata", "activity", "trash"].map((n) =>
          path.join(p.root, n),
        ),
      ),
      {
        ignoreInitial: true,
        followSymlinks: false,
        awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
        ignored: /\.tmp$/,
      },
    );
    projectWatcher
      .on("all", scheduleScan)
      .on("error", (e) => console.warn("Project watcher:", e.message));
  }
  updateTray();
}
function updateTray() {
  if (process.platform !== "win32" || !repo.settings().background) {
    tray?.destroy();
    tray = undefined;
    return;
  }
  if (tray) return;
  // A raw RGBA icon avoids relying on SVG support in Windows tray images.
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 98;
    pixels[i + 1] = 87;
    pixels[i + 2] = 217;
    pixels[i + 3] = 255;
  }
  tray = new Tray(
    nativeImage.createFromBuffer(pixels, { width: 16, height: 16 }),
  );
  tray.setToolTip("映箱");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开映箱", click: createOrShow },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", createOrShow);
}
function createOrShow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  mainWindow.focus();
}
function createWindow() {
  rendererReady = false;
  mainWindow = new BrowserWindow({
    show: !smokeReport,
    width: 1600,
    height: 1000,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: "#f6f7fb",
    title: "映箱",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  mainWindow.webContents.session.setPermissionRequestHandler(
    (contents, permission, callback) =>
      callback(
        contents === mainWindow?.webContents &&
          permission === "clipboard-sanitized-write",
      ),
  );
  mainWindow.webContents.on("did-finish-load", async () => {
    rendererReady = true;
    try {
      if (smokeReport) await runSmoke();
      else {
        await refreshWatchers();
        scanProjects();
        if (!poll) poll = setInterval(scanProjects, 3000);
      }
    } catch (e) {
      finishSmoke({ ok: false, error: e.stack });
    }
  });
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, code, description, url, isMainFrame) => {
      if (smokeReport && isMainFrame)
        finishSmoke({
          ok: false,
          error: `Renderer load failed: ${code} ${description} ${url}`,
        });
    },
  );
  if (production) mainWindow.loadFile(localFile);
  else mainWindow.loadURL(DEV_URL);
  mainWindow.on("close", (event) => {
    if (!quitting && repo.settings().background && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    rendererReady = false;
    mainWindow = undefined;
  });
}
async function call(method, payload = {}) {
  if (!METHODS.has(method)) throw new Error("Unknown desktop method");
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("Invalid payload");
  let result;
  switch (method) {
    case "bootstrap": {
      const b = repo.bootstrap();
      return {
        ...b,
        capabilities: {
          ...b.capabilities,
          nativeDialogs: true,
          remoteFetch: true,
          inboxWatcher: true,
          sharedProjectPolling: true,
          mediaProtocol: true,
          tray: process.platform === "win32",
        },
      };
    }
    case "fetchRemote":
      return fetchRemote(payload);
    case "readDocument":
      return repo.readDocument(payload).text;
    case "createProject": {
      if (payload.publicInbox)
        result = repo.createProject({ name: "待整理", publicInbox: true });
      else {
        const selected = await dialog.showOpenDialog(mainWindow, {
          title: "选择空文件夹创建项目",
          properties: ["openDirectory", "createDirectory"],
        });
        if (selected.canceled) return { canceled: true };
        if (
          repo.settings().inboxPath &&
          overlap(
            fs.realpathSync(selected.filePaths[0]),
            fs.realpathSync(repo.settings().inboxPath),
          )
        )
          throw new Error("项目文件夹不能与收件箱重叠");
        result = repo.createProject({
          name: payload.name,
          root: selected.filePaths[0],
        });
      }
      break;
    }
    case "openProject": {
      let input = payload.path || payload.root;
      if (!input) {
        const selected = await dialog.showOpenDialog(mainWindow, {
          title: "打开映箱项目文件夹",
          properties: ["openDirectory"],
        });
        if (selected.canceled) return { canceled: true };
        input = selected.filePaths[0];
      }
      result = repo.openProject({ path: input });
      break;
    }
    case "listProjectBackups":
      return repo.safety.list(payload.projectId);
    case "createProjectBackup":
      result = repo.safety.create(payload.projectId, payload.includeTrash !== false);
      break;
    case "restoreProjectBackup": {
      const selected = await dialog.showOpenDialog(mainWindow, {
        title: "选择空文件夹恢复为独立项目",
        properties: ["openDirectory", "createDirectory"],
      });
      if (selected.canceled) return { canceled: true };
      result = repo.safety.restore({
        projectId: payload.projectId,
        backupId: payload.backupId,
        destination: selected.filePaths[0],
      });
      break;
    }
    case "pickFiles": {
      const selected = await dialog.showOpenDialog(mainWindow, {
        title: "导入文件或文件夹",
        properties: ["openFile", "openDirectory", "multiSelections"],
      });
      if (selected.canceled) return { canceled: true };
      result = repo.importFiles({ ...payload, paths: selected.filePaths });
      break;
    }
    case "chooseInbox": {
      const selected = await dialog.showOpenDialog(mainWindow, {
        title: "选择收件箱文件夹",
        properties: ["openDirectory", "createDirectory"],
      });
      if (selected.canceled) return { canceled: true };
      const folder = receipts.validate(selected.filePaths[0]);
      if (!payload.importExisting) receipts.baseline(folder);
      result = repo.saveSettings({ patch: { inboxPath: folder } });
      break;
    }
    case "saveSettings": {
      if (payload.patch?.inboxPath) {
        const folder = receipts.validate(payload.patch.inboxPath);
        if (folder !== repo.settings().inboxPath) receipts.baseline(folder);
      }
      result = repo.saveSettings(payload);
      break;
    }
    case "exportProject": {
      let destination = payload.destination;
      if (!destination) {
        const selected = await dialog.showOpenDialog(mainWindow, {
          title: "导出到文件夹",
          properties: ["openDirectory", "createDirectory"],
        });
        if (selected.canceled) return { canceled: true };
        destination = selected.filePaths[0];
      }
      result = await repo.exportProject({ ...payload, destination });
      break;
    }
    case "revealAsset": {
      const { file } = repo.resolveAsset(payload);
      shell.showItemInFolder(file);
      return { ok: true };
    }
    default:
      result = await repo[method](payload);
  }
  if (MUTATIONS.has(method) && !smokeReport) {
    await refreshWatchers();
    scanProjects();
    emit(method, repo.bootstrap().snapshot);
  }
  return result;
}
function enqueue(method, payload) {
  const next = pending.then(() => call(method, payload));
  pending = next.catch(() => {});
  return next;
}
function installMediaProtocol() {
  protocol.handle("weave-media", (request) => {
    try {
      if (!["GET", "HEAD"].includes(request.method))
        return new Response(null, { status: 405 });
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      if (
        url.hostname !== "asset" ||
        parts.length !== 2 ||
        url.username ||
        url.password ||
        url.search
      )
        return new Response(null, { status: 404 });
      const { file, asset } = repo.resolveAsset({
        projectId: parts[0],
        id: parts[1],
      });
      const size = fs.statSync(file).size;
      const headers = {
        "Content-Type": asset.mime,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Accept-Ranges": "bytes",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        Vary: "Origin",
      };
      let start = 0,
        end = size - 1,
        status = 200;
      const origin = request.headers.get("origin");
      const rendererOrigin = production ? "null" : new URL(DEV_URL).origin;
      if (origin === rendererOrigin)
        headers["Access-Control-Allow-Origin"] = rendererOrigin;
      const range = request.headers.get("range");
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!m || (!m[1] && !m[2]))
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${size}` },
          });
        start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
        end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= size
        )
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${size}` },
          });
        headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
        status = 206;
      }
      headers["Content-Length"] = String(Math.max(0, end - start + 1));
      return new Response(
        request.method === "HEAD" || size === 0
          ? null
          : Readable.toWeb(fs.createReadStream(file, { start, end })),
        { status, headers },
      );
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
let smokeFinished = false;
function finishSmoke(report) {
  if (!smokeReport || smokeFinished) return;
  smokeFinished = true;
  atomic(path.resolve(smokeReport), {
    ...report,
    dataDirectory: smokeRoot,
    electron: process.versions.electron,
    timestamp: new Date().toISOString(),
  });
  console.log("WEAVE_SMOKE", JSON.stringify(report));
  quitting = true;
  app.exit(report.ok ? 0 : 1);
}
async function runSmoke() {
  const snapshot = repo.createProject({
    name: "Smoke",
    root: path.join(smokeRoot, "project"),
  });
  const projectId = snapshot.project.id;
  // Exercise the actual sandboxed preload and IPC, not just direct repository calls.
  const report = await mainWindow.webContents.executeJavaScript(`(async () => {
    const api = window.weaveDesktop; if (!api) throw new Error('Missing preload bridge');
    const projectId = ${JSON.stringify(projectId)};
    await api.invoke('selectProject', {id: projectId});
    await api.invoke('importFiles', {projectId, files:[{name:'smoke.txt',bytes:[87,101,97,118,101]}]});
    let b = await api.invoke('bootstrap'); const a = b.snapshot.assets[0];
    const doc = await api.invoke('readDocument',{projectId,id:a.id}); if (doc !== 'Weave') throw new Error('Document persistence failed');
    const media = await fetch(a.url); if (!media.ok || await media.text() !== 'Weave') throw new Error('Media protocol failed');
    const range = await fetch(a.url, {headers:{Range:'bytes=1-2'}}); if (range.status !== 206 || await range.text() !== 'ea') throw new Error('Media range failed');
    await api.invoke('updateAssets',{projectId,ids:[a.id],patch:{status:'final'},revisions:{[a.id]:a.revision}});
    let conflict = false; try { await api.invoke('updateAssets',{projectId,ids:[a.id],patch:{status:'rejected'},revisions:{[a.id]:a.revision}}); } catch(e) { conflict = String(e).includes('CONFLICT'); } if (!conflict) throw new Error('Conflict missing');
    b = await api.invoke('bootstrap'); if (b.snapshot.assets[0].status !== 'final') throw new Error('Mutation bootstrap failed');
    await api.invoke('trashAssets',{projectId,ids:[a.id],revisions:{[a.id]:b.snapshot.assets[0].revision}});
    const denied = await fetch(a.url); if (denied.status !== 404) throw new Error('Trashed media authorized');
    b = await api.invoke('bootstrap'); await api.invoke('restoreAssets',{projectId,ids:[a.id],revisions:{[a.id]:b.snapshot.assets[0].revision}});
    await api.invoke('createShot',{projectId,title:'Smoke shot'});
    await api.invoke('importFiles',{projectId,files:[{name:'pixel.png',bytes:Array.from(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII='),c=>c.charCodeAt(0)))}]});
    b = await api.invoke('bootstrap'); const png = b.snapshot.assets.find(a=>a.kind==='image'); const image = new Image(); image.crossOrigin = 'anonymous'; await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Image CORS failed'));image.src=png.url;}); const canvas=document.createElement('canvas');canvas.width=canvas.height=1;canvas.getContext('2d').drawImage(image,0,0); if (!canvas.toDataURL().startsWith('data:image/png')) throw new Error('Canvas export failed');
    const exported = await api.invoke('exportProject',{projectId,format:'zip',include:{originals:true,storyboard:true},destination:${JSON.stringify(path.join(smokeRoot, "exports"))}});
    b = await api.invoke('bootstrap'); if (b.settings.api?.key) throw new Error('Raw key exposed');
    return {ok:true,rendererLoaded:document.body.innerText.length>0,bridge:true,mediaProtocol:true,canvasExport:true,range:true,conflict:true,trashRestore:true,zipPath:exported.zipPath,capabilities:b.capabilities};
  })()`);
  if (!report.rendererLoaded) throw new Error("Renderer page is empty");
  const inbox = path.join(smokeRoot, "inbox");
  fs.mkdirSync(inbox);
  fs.writeFileSync(path.join(inbox, "already-present.txt"), "Baseline only");
  receipts.baseline(inbox);
  const receivingShot = repo.snapshot(projectId).shots[0];
  repo.saveSettings({
    patch: {
      inboxPath: inbox,
      receiveProjectId: projectId,
      receiveShotId: receivingShot.id,
    },
  });
  await refreshWatchers();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Inbox watcher did not become ready")),
      8000,
    );
    inboxWatcher.once("ready", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  fs.writeFileSync(
    path.join(inbox, "watcher-download.txt"),
    "A completed browser download",
  );
  let received;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const current = repo.snapshot(projectId);
    received = current.assets.find(
      (asset) => asset.name === "watcher-download.txt",
    );
    if (received) {
      if (
        !current.shots
          .find((shot) => shot.id === receivingShot.id)
          .assetIds?.includes(received.id)
      )
        throw new Error("Watched download did not link to its receiving shot");
      if (current.assets.some((asset) => asset.name === "already-present.txt"))
        throw new Error("Watcher imported baseline files");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!received) throw new Error("Completed download never arrived in project");
  report.inboxWatcher = true;
  const menu = Menu.getApplicationMenu();
  if (
    !menu ||
    menu.items.map((item) => item.label).join(",") !== "文件,编辑,视图,窗口"
  )
    throw new Error("Application menu is not localized");
  report.chineseMenu = true;
  finishSmoke(report);
}
if (!smokeReport && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (repo) createOrShow();
  });
  app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(applicationMenuTemplate()),
      );
      const encrypted =
        safeStorage.isEncryptionAvailable() &&
        safeStorage.getSelectedStorageBackend?.() !== "basic_text";
      repo = new ProjectRepository({
        userData: app.getPath("userData"),
        ...(encrypted
          ? {
              encodeKey: (key) =>
                safeStorage.encryptString(key).toString("base64"),
              decodeKey: (key) =>
                safeStorage.decryptString(Buffer.from(key, "base64")),
            }
          : {}),
      });
      receipts = new InboxReceipts(repo);
      const previous = repo.registry().activeProjectId;
      const inbox = repo.createProject({
        name: "待整理",
        publicInbox: true,
      });
      if (previous && previous !== inbox.project.id) {
        try {
          repo.selectProject({ id: previous });
        } catch {}
      }
      installMediaProtocol();
      ipcMain.handle("weave:invoke", async (event, method, payload) => {
        trusted(event);
        try {
          return await enqueue(method, payload);
        } catch (e) {
          throw new Error(
            `${e.code || "ERROR"}: ${e.message}${e.code === "CONFLICT" ? ` (id=${e.id}, actual=${e.actual})` : ""}`,
          );
        }
      });
      ipcMain.on("weave:drag-asset", (event, payload) => {
        try {
          trusted(event);
          if (
            !payload ||
            typeof payload.projectId !== "string" ||
            typeof payload.assetId !== "string"
          )
            throw new Error("Invalid asset drag request");
          const { file } = repo.resolveAsset({
            projectId: payload.projectId,
            id: payload.assetId,
          });
          const pixels = Buffer.alloc(32 * 32 * 4);
          for (let i = 0; i < pixels.length; i += 4) {
            pixels[i] = 104;
            pixels[i + 1] = 87;
            pixels[i + 2] = 225;
            pixels[i + 3] = 255;
          }
          event.sender.startDrag({
            file,
            icon: nativeImage.createFromBuffer(pixels, {
              width: 32,
              height: 32,
            }),
          });
        } catch (error) {
          console.warn("Native asset drag failed:", error.message);
        }
      });
      ipcMain.handle("inbox:choose-folder", async (event) => {
        trusted(event);
        const result = await enqueue("chooseInbox", {});
        return result.canceled ? null : repo.settings().inboxPath;
      });
      ipcMain.handle("project:export", async (event, payload) => {
        trusted(event);
        return enqueue("exportProject", payload);
      });
      ipcMain.handle("update:check", async (event) => {
        trusted(event);
        if (!app.isPackaged || process.platform !== "win32")
          return { available: false, unsupported: true, currentVersion: app.getVersion() };
        return checkLatestRelease({ currentVersion: app.getVersion() });
      });
      ipcMain.handle("update:download", async (event) => {
        trusted(event);
        if (!app.isPackaged || process.platform !== "win32")
          throw new Error("自动下载更新仅适用于 Windows 便携桌面版");
        const update = await checkLatestRelease({ currentVersion: app.getVersion() });
        if (!update.available) return { available: false, currentVersion: app.getVersion() };
        emitUpdate({ state: "downloading", version: update.version, size: update.size });
        const result = await downloadRelease({ update, downloadsPath: app.getPath("downloads") });
        const completed = { state: "downloaded", version: update.version, ...result };
        emitUpdate(completed);
        return completed;
      });
      ipcMain.handle("update:open", async (event, filePath) => {
        trusted(event);
        const downloads = path.resolve(app.getPath("downloads"));
        const target = path.resolve(String(filePath || ""));
        const relative = path.relative(downloads, target);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !/^Weave-Windows-v\d+\.\d+\.\d+(?:-[a-f\d]{8})?\.zip$/i.test(path.basename(target)))
          throw new Error("只能打开下载目录内经过校验的 Weave 更新包");
        shell.showItemInFolder(target);
        return { ok: true };
      });
      createWindow();
      setTimeout(() => void checkAndDownloadUpdate(), 8000);
      app.on("activate", createOrShow);
      if (smokeReport)
        setTimeout(
          () => finishSmoke({ ok: false, error: "Smoke test timed out" }),
          45000,
        );
    })
    .catch((e) => {
      console.error(e);
      if (smokeReport) finishSmoke({ ok: false, error: e.stack });
      else {
        dialog.showErrorBox("映箱启动失败", e.message);
        app.quit();
      }
    });
}
app.on("before-quit", () => {
  quitting = true;
  clearInterval(poll);
  clearTimeout(timer);
  clearTimeout(inboxTimer);
  inboxWatcher?.close();
  projectWatcher?.close();
  tray?.destroy();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !repo?.settings().background) app.quit();
});
