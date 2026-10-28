import { expandStackIds } from "./asset-stacks.mjs";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const fail = (message) => {
  throw new Error(message);
};
const text = (value, max = 1000000) =>
  typeof value === "string" && value.length <= max;
const stamp = () => new Date().toISOString();
const paragraph = (value) => ({
  id: crypto.randomUUID(),
  text: value,
  generated: false,
  links: [],
  notes: [],
  marks: [],
});
export function splitDocument(value, mode = "blank") {
  if (!text(value) || !value.trim()) fail("请先粘贴文稿（最多 100 万字）");
  if (!["blank", "line"].includes(mode)) fail("分段方式无效");
  return value
    .replace(/\r\n?/g, "\n")
    .split(mode === "line" ? /\n/ : /\n[\t ]*\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
export function validateEditing(value, assets) {
  if (!value || value.version !== 1)
    fail("剪辑文稿格式不受支持，请更新 Weave；原数据未修改");
  const doc = structuredClone(value),
    ids = new Set(assets.map((asset) => asset.id));
  if (
    !uuid.test(doc.id) ||
    !Number.isInteger(doc.revision) ||
    doc.revision < 1 ||
    !text(doc.title, 200) ||
    !doc.title.trim() ||
    !text(doc.updatedAt, 64) ||
    !Array.isArray(doc.sources) ||
    !Array.isArray(doc.paragraphs) ||
    !Array.isArray(doc.removed) ||
    doc.paragraphs.length + doc.removed.length > 4000
  )
    fail("剪辑文稿记录无效");
  const seen = new Set();
  for (const p of [
    ...doc.paragraphs,
    ...doc.removed.map((item) => item.paragraph),
  ]) {
    if (
      !p ||
      !uuid.test(p.id) ||
      seen.has(p.id) ||
      !text(p.text) ||
      typeof p.generated !== "boolean" ||
      !Array.isArray(p.links) ||
      !Array.isArray(p.notes) ||
      !Array.isArray(p.marks) ||
      p.links.length > 1000 ||
      p.notes.length > 1000 ||
      p.marks.length > 1000
    )
      fail("段落记录无效");
    seen.add(p.id);
    const linked = new Set();
    let primaries = 0;
    for (const link of p.links) {
      if (
        !link ||
        !ids.has(link.assetId) ||
        linked.has(link.assetId) ||
        !["primary", "alternate"].includes(link.role)
      )
        fail("段落素材关联无效");
      linked.add(link.assetId);
      if (link.role === "primary") primaries++;
    }
    if (primaries > 1) fail("每段只能设置一个主选");
    const noteIds = new Set();
    for (const note of p.notes) {
      if (
        !note ||
        !uuid.test(note.id) ||
        noteIds.has(note.id) ||
        !text(note.text, 10000) ||
        !text(note.quote, 10000) ||
        typeof note.resolved !== "boolean" ||
        !text(note.createdAt, 64)
      )
        fail("批注记录无效");
      noteIds.add(note.id);
    }
    for (const mark of p.marks)
      if (
        !mark ||
        !Number.isInteger(mark.start) ||
        !Number.isInteger(mark.end) ||
        mark.start < 0 ||
        mark.end <= mark.start ||
        mark.end > p.text.length
      )
        fail("文字标记位置无效");
    if (p.legacyShotId !== undefined && !uuid.test(p.legacyShotId))
      fail("旧镜头来源无效");
  }
  for (const item of doc.removed)
    if (
      !Number.isInteger(item.index) ||
      item.index < 0 ||
      !text(item.removedAt, 64)
    )
      fail("移除记录无效");
  const sourceIds = new Set();
  for (const source of doc.sources) {
    if (
      !source ||
      !uuid.test(source.id) ||
      sourceIds.has(source.id) ||
      !text(source.text) ||
      !text(source.createdAt, 64)
    )
      fail("原始文稿记录无效");
    sourceIds.add(source.id);
  }
  if (JSON.stringify(doc).length > 3000000)
    fail("文稿记录过大，请分开项目保存");
  return doc;
}
/** Every command is one revision-checked atomic project mutation. Originals are never touched. */
export function applyEditing(
  current,
  action,
  assets,
  shots = [],
  expectedRevision = 0,
) {
  if (!action || typeof action !== "object" || !text(action.type, 50))
    fail("文稿操作无效");
  if ((current?.revision || 0) !== expectedRevision)
    fail("文稿已在其他窗口更新，请刷新后重试；未覆盖修改");
  if (action.type === "restoreDocument") {
    if (action.document === null) {
      if (!current) fail("没有可撤回的文稿");
      return validateEditing(
        {
          version: 1,
          id: current.id,
          revision: current.revision + 1,
          title: current.title,
          updatedAt: stamp(),
          sources: [],
          paragraphs: [],
          removed: [],
        },
        assets,
      );
    }
    const restored = validateEditing(action.document, assets);
    if (current && restored.id !== current.id)
      fail("撤回目标不属于当前文稿");
    restored.revision = (current?.revision || 0) + 1;
    restored.updatedAt = stamp();
    return validateEditing(restored, assets);
  }
  const doc = current
    ? validateEditing(current, assets)
    : {
        version: 1,
        id: crypto.randomUUID(),
        revision: 0,
        title: "剪辑文稿",
        updatedAt: stamp(),
        sources: [],
        paragraphs: [],
        removed: [],
      };
  const find = () =>
    doc.paragraphs.find((p) => p.id === action.id) ||
    fail("段落不存在或已移除");
  const remove = (p, index) => {
    doc.removed.push({ paragraph: p, index, removedAt: stamp() });
    doc.paragraphs.splice(index, 1);
  };
  switch (action.type) {
    case "import": {
      const parts = splitDocument(action.text, action.mode);
      doc.sources.push({
        id: crypto.randomUUID(),
        text: action.text,
        createdAt: stamp(),
      });
      doc.paragraphs.push(...parts.map(paragraph));
      break;
    }
    case "title":
      if (!text(action.title, 200) || !action.title.trim())
        fail("请填写文稿名称");
      doc.title = action.title.trim();
      break;
    case "add":
      doc.paragraphs.push(paragraph(""));
      break;
    case "text": {
      const p = find();
      if (!text(action.text)) fail("段落文字过长");
      if (p.text !== action.text) {
        p.text = action.text;
        p.marks = [];
        p.generated = false;
      }
      break;
    }
    case "generated":
      if (typeof action.value !== "boolean") fail("标记状态无效");
      find().generated = action.value;
      break;
    case "link": {
      const p = find();
      if (!Array.isArray(action.assetIds) || !action.assetIds.length)
        fail("请选择素材");
      for (const id of expandStackIds(action.assetIds, assets)) {
        if (
          !assets.some(
            (a) => a.id === id && !a.trashedAt && a.kind !== "document",
          )
        )
          fail("素材不存在、已移除或不是可关联媒体");
        if (!p.links.some((link) => link.assetId === id))
          p.links.push({ assetId: id, role: "alternate" });
      }
      break;
    }
    case "unlink": {
      const remove = new Set(expandStackIds([action.assetId], assets, true));
      find().links = find().links.filter((link) => !remove.has(link.assetId));
      break;
    }
    case "primary": {
      const p = find();
      if (
        action.assetId !== null &&
        !p.links.some((link) => link.assetId === action.assetId)
      )
        fail("请先关联素材");
      for (const link of p.links)
        link.role = link.assetId === action.assetId ? "primary" : "alternate";
      break;
    }
    case "reorderLinks": {
      const p = find();
      if (!Array.isArray(action.assetIds) || action.assetIds.length !== p.links.length ||
        new Set(action.assetIds).size !== p.links.length ||
        action.assetIds.some(id => !p.links.some(link => link.assetId === id)))
        fail("素材排序已变化，请重新拖动");
      const rank = new Map(action.assetIds.map((id, index) => [id, index]));
      p.links.sort((a, b) => rank.get(a.assetId) - rank.get(b.assetId));
      break;
    }
    case "mark": {
      const p = find();
      if (
        action.quote !== undefined &&
        (!text(action.quote) ||
          p.text.slice(action.start, action.end) !== action.quote)
      )
        fail("选中文字已变化，请重新选择；未套用旧位置标记");
      p.marks.push({ start: action.start, end: action.end });
      break;
    }
    case "clearMarks":
      find().marks = [];
      break;
    case "note": {
      if (
        !text(action.text, 10000) ||
        !action.text.trim() ||
        !text(action.quote || "", 10000)
      )
        fail("请填写批注，最多一万字");
      find().notes.push({
        id: crypto.randomUUID(),
        text: action.text.trim(),
        quote: action.quote || "",
        resolved: false,
        createdAt: stamp(),
      });
      break;
    }
    case "resolveNote": {
      const note = find().notes.find((note) => note.id === action.noteId);
      if (!note || typeof action.value !== "boolean") fail("批注不存在");
      note.resolved = action.value;
      break;
    }
    case "deleteNote": {
      const notes = find().notes;
      const index = notes.findIndex((note) => note.id === action.noteId);
      if (index < 0) fail("批注不存在");
      notes.splice(index, 1);
      break;
    }
    case "move": {
      const p = find(),
        index = doc.paragraphs.indexOf(p);
      if (![1, -1].includes(action.direction)) fail("排序方向无效");
      const to = index + action.direction;
      if (to >= 0 && to < doc.paragraphs.length) {
        doc.paragraphs.splice(index, 1);
        doc.paragraphs.splice(to, 0, p);
      }
      break;
    }
    case "moveTo": {
      const p = find(),
        from = doc.paragraphs.indexOf(p),
        to = action.index;
      if (!Number.isInteger(to) || to < 0 || to >= doc.paragraphs.length)
        fail("目标段落位置无效");
      if (from !== to) {
        doc.paragraphs.splice(from, 1);
        doc.paragraphs.splice(to, 0, p);
      }
      break;
    }
    case "remove": {
      const p = find();
      remove(p, doc.paragraphs.indexOf(p));
      break;
    }
    case "restore": {
      const index = doc.removed.findIndex(
        (item) => item.paragraph.id === action.id,
      );
      if (index < 0) fail("段落不在已移除列表");
      const item = doc.removed.splice(index, 1)[0];
      doc.paragraphs.splice(
        Math.min(item.index, doc.paragraphs.length),
        0,
        item.paragraph,
      );
      break;
    }
    case "split": {
      const p = find(),
        at = action.at;
      if (!Number.isInteger(at) || at < 1 || at >= p.text.length)
        fail("请将光标放在段落中间");
      const right = {
        ...structuredClone(p),
        id: crypto.randomUUID(),
        text: p.text.slice(at),
        // Keep linked media on the original (left) paragraph. Cloning links made
        // a split look like the same video belonged to both segments.
        links: [],
        legacyShotId: undefined,
        marks: p.marks
          .filter((m) => m.end > at)
          .map((m) => ({ start: Math.max(0, m.start - at), end: m.end - at })),
        notes: [],
      };
      p.text = p.text.slice(0, at);
      p.marks = p.marks
        .filter((m) => m.start < at)
        .map((m) => ({ start: m.start, end: Math.min(at, m.end) }));
      doc.paragraphs.splice(doc.paragraphs.indexOf(p) + 1, 0, right);
      break;
    }
    case "extractSelection": {
      const p = find(),
        start = action.start,
        end = action.end,
        originalText = p.text;
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start ||
        end > originalText.length ||
        !text(action.quote, 1000000) ||
        originalText.slice(start, end) !== action.quote
      )
        fail("选中文字已变化，请重新选择后再拆段");
      const base = structuredClone(p),
        sourceMarks = structuredClone(p.marks),
        segments = [
          { start: 0, end: start, text: originalText.slice(0, start) },
          { start, end, text: originalText.slice(start, end) },
          { start: end, end: originalText.length, text: originalText.slice(end) },
        ].filter((segment) => segment.text.length > 0);
      if (segments.length < 2)
        fail("这段文字已单独成段，无需再次拆分");
      const paragraphs = segments.map((segment, index) => {
        const next = index === 0 ? base : structuredClone(base);
        next.id = index === 0 ? base.id : crypto.randomUUID();
        next.text = segment.text;
        next.marks = sourceMarks
          .filter((mark) => mark.end > segment.start && mark.start < segment.end)
          .map((mark) => ({
            start: Math.max(mark.start, segment.start) - segment.start,
            end: Math.min(mark.end, segment.end) - segment.start,
          }));
        if (index > 0) {
          // New segments are independent; keep existing media only on the
          // original paragraph, as with splitting at a caret.
          next.links = [];
          next.notes = [];
          next.legacyShotId = undefined;
        }
        return next;
      });
      doc.paragraphs.splice(doc.paragraphs.indexOf(p), 1, ...paragraphs);
      break;
    }
    case "combineSelections": {
      if (!Array.isArray(action.selections) || action.selections.length < 2 || action.selections.length > 100)
        fail("请至少加入两段选中文字");
      const selections = action.selections.map((selection) => {
        const p = doc.paragraphs.find((item) => item.id === selection?.id);
        const { start, end, quote } = selection || {};
        if (
          !p || !Number.isInteger(start) || !Number.isInteger(end) ||
          start < 0 || end <= start || end > p.text.length ||
          !text(quote, 100000) || p.text.slice(start, end) !== quote
        ) fail("选中文字已变化，请重新选择后再合并");
        return { p, start, end, quote, index: doc.paragraphs.indexOf(p) };
      }).sort((a, b) => a.index - b.index || a.start - b.start);
      if (new Set(selections.map((item) => item.p.id)).size < 2)
        fail("请从至少两个不同段落中选择文字");
      for (let i = 1; i < selections.length; i++) {
        const previous = selections[i - 1], current = selections[i];
        if (previous.p.id === current.p.id && previous.end > current.start)
          fail("同一段中的选中文字不能重叠");
      }
      const grouped = new Map();
      for (const selection of selections) {
        const ranges = grouped.get(selection.p.id) || [];
        ranges.push(selection);
        grouped.set(selection.p.id, ranges);
      }
      for (const [id, ranges] of grouped) {
        const p = doc.paragraphs.find((item) => item.id === id);
        const original = p.text;
        let cursor = 0, nextText = "";
        for (const range of ranges) {
          nextText += original.slice(cursor, range.start);
          cursor = range.end;
        }
        p.text = nextText + original.slice(cursor);
        p.generated = false;
        p.marks = p.marks.flatMap((mark) => {
          let position = mark.start;
          const kept = [];
          for (const range of ranges) {
            if (range.end <= position || range.start >= mark.end) continue;
            if (range.start > position) kept.push({ start: position, end: Math.min(range.start, mark.end) });
            position = Math.max(position, range.end);
          }
          if (position < mark.end) kept.push({ start: position, end: mark.end });
          return kept.map((mark) => {
            const removedBefore = ranges.reduce((sum, range) => sum + (range.end <= mark.start ? range.end - range.start : 0), 0);
            return { start: mark.start - removedBefore, end: mark.end - removedBefore };
          }).filter((mark) => mark.end > mark.start);
        });
      }
      const first = selections[0],
        combined = paragraph(selections.map((item) => item.quote).join("\n"));
      doc.paragraphs.splice(first.index + 1, 0, combined);
      break;
    }
    case "merge": {
      const p = find(),
        index = doc.paragraphs.indexOf(p),
        count = action.count === undefined ? 1 : action.count;
      if (!Number.isInteger(count) || count < 1 || index + count >= doc.paragraphs.length)
        fail("所选段落范围无效");
      for (let step = 0; step < count; step++) {
        const right = doc.paragraphs[index + 1];
        if (!right) fail("没有下一段");
        const offset = p.text.length + 2;
        p.text += "\n\n" + right.text;
        p.generated = p.generated && right.generated;
        const linksBeforeMerge = new Set(
          [...p.links, ...right.links].map((link) => link.assetId),
        );
        for (const link of right.links) {
          const existing = p.links.find((item) => item.assetId === link.assetId);
          if (existing) {
            // A repeated reference can carry the source paragraph's primary role.
            // Keep that role only when the merged paragraph has no other primary.
            if (
              link.role === "primary" &&
              existing.role !== "primary" &&
              !p.links.some(
                (item) => item !== existing && item.role === "primary",
              )
            )
              existing.role = "primary";
            continue;
          }
          p.links.push({
            ...link,
            role:
              link.role === "primary" &&
              !p.links.some((item) => item.role === "primary")
                ? "primary"
                : "alternate",
          });
        }
        if (
          [...linksBeforeMerge].some(
            (assetId) => !p.links.some((link) => link.assetId === assetId),
          )
        )
          fail("合并后素材关联校验失败，段落与素材均未删除");
        p.notes.push(
          ...structuredClone(right.notes).filter(
            (note) => !p.notes.some((existing) => existing.id === note.id),
          ),
        );
        p.marks.push(
          ...right.marks.map((m) => ({
            start: m.start + offset,
            end: m.end + offset,
          })),
        );
        remove(right, index + 1);
      }
      break;
    }
    case "legacy": {
      for (const shot of [...shots].sort(
        (a, b) => (a.order || 0) - (b.order || 0),
      )) {
        if (
          [
            ...doc.paragraphs,
            ...doc.removed.map((item) => item.paragraph),
          ].some((p) => p.legacyShotId === shot.id)
        )
          continue;
        const p = paragraph(
          [shot.title, shot.description, shot.dialogue]
            .filter(Boolean)
            .join("\n\n"),
        );
        p.legacyShotId = shot.id;
        p.generated = shot.status === "done";
        p.links = (
          shot.assetIds ||
          assets.filter((a) => a.shotId === shot.id).map((a) => a.id)
        )
          .filter((id) =>
            assets.some(
              (a) => a.id === id && !a.trashedAt && a.kind !== "document",
            ),
          )
          .map((assetId) => ({ assetId, role: "alternate" }));
        doc.paragraphs.push(p);
      }
      break;
    }
    default:
      fail("不支持的文稿操作");
  }
  doc.revision++;
  doc.updatedAt = stamp();
  return validateEditing(doc, assets);
}
export function editingForExport(value, assetIds) {
  if (!value) return undefined;
  const doc = structuredClone(value),
    allowed = new Set(assetIds);
  for (const p of [
    ...doc.paragraphs,
    ...doc.removed.map((item) => item.paragraph),
  ])
    p.links = p.links.filter((link) => allowed.has(link.assetId));
  return doc;
}
