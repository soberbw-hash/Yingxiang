import { validateEditing } from "./editing.mjs";

const labels = { text: "编辑正文", split: "拆分段落", extractSelection: "拆出选中文字", combineSelections: "合并选中文字", merge: "合并段落", move: "移动段落", moveTo: "拖动段落", remove: "移除段落", restore: "恢复段落", restoreDocument: "恢复文稿版本", link: "关联素材", unlink: "移除素材关联", reorderLinks: "调整素材顺序", generated: "标记完成", note: "新增批注", deleteNote: "删除批注", resolveNote: "更新批注", title: "修改标题", import: "导入文稿", add: "添加段落", legacy: "导入旧镜头" };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** Historical references may name media moved out of the project later. Keep
 * those references in history; restoring still validates against live assets. */
export function validateEditingHistory(value = []) {
  if (!Array.isArray(value) || value.length > 40 || JSON.stringify(value).length > 16000000)
    throw new Error("文稿历史格式无效或过大，请保留项目备份");
  const ids = new Set();
  return value.map(entry => {
    if (!entry || !uuid.test(entry.id) || ids.has(entry.id) ||
      typeof entry.label !== "string" || entry.label.length > 100 ||
      !Number.isFinite(Date.parse(entry.createdAt)) || typeof entry.actionType !== "string")
      throw new Error("文稿历史记录无效");
    ids.add(entry.id);
    const doc = entry.document;
    const refs = [...(doc?.paragraphs || []), ...(doc?.removed || []).map(x => x.paragraph)]
      .flatMap(p => (p?.links || []).map(link => link?.assetId));
    if (refs.some(id => !uuid.test(id))) throw new Error("历史文稿素材引用无效");
    return { ...structuredClone(entry), document: validateEditing(doc, refs.map(id => ({ id }))) };
  });
}

export function rememberEditingVersion(history, current, action, now = new Date().toISOString()) {
  const next = validateEditingHistory(history);
  if (!current) return next;
  const previous = next.at(-1);
  // Preserve the state before a typing burst, rather than a version per letter.
  if (action.type === "text" && previous?.actionType === "text" &&
      previous.paragraphId === action.id && previous.document.id === current.id &&
      Date.parse(now) - Date.parse(previous.createdAt) >= 0 &&
      Date.parse(now) - Date.parse(previous.createdAt) < 120000) return next;
  next.push({ id: crypto.randomUUID(), createdAt: now,
    label: labels[action.type] || "更新文稿", actionType: action.type,
    ...(action.id ? { paragraphId: action.id } : {}), document: structuredClone(current) });
  while (next.length > 40 || JSON.stringify(next).length > 12000000) next.shift();
  return next;
}
