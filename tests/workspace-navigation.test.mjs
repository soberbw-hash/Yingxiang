import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import "fake-indexeddb/auto";
import { projectLabel } from "../shared/workspace-labels.mjs";
import {
  browserInvoke,
  browserProjectData,
} from "../src/services/browserRepository.ts";

const channel = globalThis.BroadcastChannel;
globalThis.BroadcastChannel = undefined;
after(() => {
  globalThis.BroadcastChannel = channel;
});

test("legacy staging label changes without renaming private projects or mutating metadata", () => {
  const legacy = {
    id: "unchanged",
    name: "公共收件箱",
    publicInbox: true,
    root: "old-root",
  };
  const original = structuredClone(legacy);
  assert.equal(projectLabel(legacy), "待整理");
  assert.deepEqual(legacy, original);
  assert.equal(
    projectLabel({ name: "公共收件箱", publicInbox: false }),
    "公共收件箱",
  );
  assert.equal(projectLabel({ name: "我的项目" }), "我的项目");
  assert.equal(projectLabel(), "");
});

test("opening renamed staging reuses the existing inbox and preserves files and identity", async () => {
  const legacy = await browserInvoke("createProject", {
    name: "公共收件箱",
    publicInbox: true,
  });
  const file = new File(["原始脚本内容"], "测试脚本.txt", {
    type: "text/plain",
  });
  await browserInvoke("importFiles", {
    projectId: legacy.id,
    files: [{ name: file.name, blob: file }],
    category: "script",
  });
  const before = await browserProjectData(legacy.id);
  const reused = await browserInvoke("createProject", {
    name: "待整理",
    publicInbox: true,
  });
  assert.equal(reused.id, legacy.id);
  const boot = await browserInvoke("bootstrap");
  assert.equal(boot.projects.filter((p) => p.publicInbox).length, 1);
  assert.equal(projectLabel(boot.snapshot.project), "待整理");
  const after = await browserProjectData(legacy.id);
  assert.deepEqual(after.record, before.record);
  assert.equal(after.media.length, before.media.length);
  assert.equal(await after.media[0].blob.text(), await file.text());
});

test("staging entry is removed while legacy data remains reachable from projects", async () => {
  const app = await readFile(
    new URL("../src/App.tsx", import.meta.url),
    "utf8",
  );
  const sidebar = app.slice(
    app.indexOf('<aside className="sidebar">'),
    app.indexOf("</aside>"),
  );
  assert.doesNotMatch(sidebar, /待整理/);
  assert.doesNotMatch(app, /ensureInbox|__inbox/);
  assert.match(app, /请先选择或新建项目，再导入素材/);
  const home = await readFile(new URL("../src/components/ProjectHome.tsx", import.meta.url), "utf8");
  assert.match(home, /旧待整理素材（保留）/);
  assert.ok(
    sidebar.indexOf('className="sidebar-bottom"') <
      sidebar.indexOf("<span>通知</span>"),
  );
  assert.ok(sidebar.indexOf("<span>通知</span>") < sidebar.indexOf("设置"));
  assert.match(sidebar, /!!unread && <small>\{unread\}<\/small>/);
  assert.doesNotMatch(app, /公共收件箱|公共库更新/);
  const updates = await readFile(
    new URL("../src/features/SharedLibraryView.tsx", import.meta.url),
    "utf8",
  );
  const list = await readFile(
    new URL("../src/features/LibraryNotificationList.tsx", import.meta.url),
    "utf8",
  );
  assert.match(list, /暂无通知/);
  assert.match(updates, /公共素材库的新增记录/);
  assert.match(updates, /library\.markRead\(update\.entryIds\)/);
  assert.match(updates, /setLocate\(update\.assetIds\)/);
});
