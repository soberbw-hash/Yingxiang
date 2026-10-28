import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { bindDragCleanup } from "../src/services/dragLifecycle.ts";
import { readImportNaming } from "../src/services/importNames.ts";
import {
  pcmWaveform,
  MAX_WAVEFORM_BYTES,
  audioDuration,
} from "../src/services/audioWaveform.ts";
import {
  writeMediaFileDrag,
  writeAssetDrag,
} from "../src/services/assetOutbound.ts";

function wav(samples, channels = 1) {
  const bytes = new ArrayBuffer(44 + samples.length * 2),
    d = new DataView(bytes);
  const text = (offset, value) =>
    [...value].forEach((c, i) => d.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  d.setUint32(4, bytes.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  d.setUint32(16, 16, true);
  d.setUint16(20, 1, true);
  d.setUint16(22, channels, true);
  d.setUint32(24, 48000, true);
  d.setUint32(28, 48000 * channels * 2, true);
  d.setUint16(32, channels * 2, true);
  d.setUint16(34, 16, true);
  text(36, "data");
  d.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => d.setInt16(44 + i * 2, sample, true));
  return bytes;
}
test("naming defaults on, preserves explicit off and never fails for denied storage", () => {
  assert.equal(
    readImportNaming(() => null),
    true,
  );
  assert.equal(
    readImportNaming(() => "false"),
    false,
  );
  assert.equal(
    readImportNaming(() => "true"),
    true,
  );
  assert.equal(
    readImportNaming(() => {
      throw Error("denied");
    }),
    true,
  );
});
test("drop cleanup uses capture, handles cancellation/focus and removes all listeners", () => {
  const registrations = [],
    removed = [];
  const target = {
    addEventListener: (...args) => registrations.push(args),
    removeEventListener: (...args) => removed.push(args),
  };
  let resets = 0;
  const unbind = bindDragCleanup(target, () => resets++);
  for (const name of [
    "drop",
    "dragend",
    "blur",
    "focus",
    "pointerdown",
    "visibilitychange",
  ]) {
    const item = registrations.find(([type]) => type === name);
    assert.equal(item[2], true);
    item[1](new Event(name));
  }
  const key = registrations.find(([type]) => type === "keydown")[1];
  key({ key: "a" });
  assert.equal(resets, 6);
  key({ key: "Escape" });
  assert.equal(resets, 7);
  unbind();
  assert.deepEqual(removed, registrations);
});
test("PCM previews preserve silence and use both channels without changing bytes", () => {
  const bytes = wav(Array(960).fill(0)),
    before = bytes.slice(0);
  assert.deepEqual(pcmWaveform(bytes).peaks, Array(48).fill(0));
  assert.deepEqual(bytes, before);
  const stereo = wav(
    Array.from({ length: 960 }, (_, i) => (i % 2 ? -16384 : 0)),
    2,
  );
  const wave = pcmWaveform(stereo);
  assert.ok(wave.peaks.every((peak) => peak === 0.5));
  assert.equal(wave.duration, 480 / 48000);
});
test("waveform guards reject malformed/oversized/unsupported data and duration never lies", () => {
  assert.equal(pcmWaveform(new ArrayBuffer(10)), undefined);
  assert.equal(pcmWaveform(new ArrayBuffer(MAX_WAVEFORM_BYTES + 1)), undefined);
  const bytes = wav([1, 2]);
  new DataView(bytes).setUint32(40, 1000, true);
  assert.equal(pcmWaveform(bytes), undefined);
  const bad = wav([1, 2]);
  new DataView(bad).setUint16(20, 65535, true);
  assert.equal(pcmWaveform(bad), undefined);
  assert.equal(audioDuration(Infinity), "音频");
  assert.equal(audioDuration(74.9), "1:14");
});
test("audio compatibility payload retains internal IDs, original MIME/name and excludes image drags", () => {
  const strings = new Map(),
    transfer = { setData: (k, v) => strings.set(k, v) };
  const audio = {
    id: "a",
    kind: "audio",
    name: "旁白:原片.wav",
    mime: "audio/wav",
    url: "blob:http://localhost/wav",
  };
  writeAssetDrag(transfer, [audio]);
  assert.equal(writeMediaFileDrag(transfer, audio), true);
  assert.equal(
    strings.get("DownloadURL"),
    "audio/wav:旁白_原片.wav:blob:http://localhost/wav",
  );
  assert.equal(strings.get("application/weave-assets"), '["a"]');
  assert.equal(strings.has("text/plain"), false);
  assert.equal(
    writeMediaFileDrag(transfer, { ...audio, kind: "image" }),
    false,
  );
  assert.equal(
    writeMediaFileDrag(transfer, { ...audio, url: "file:///private.wav" }),
    false,
  );
});
test("capture and audio UI wire reset, lazy bounded waveforms, preview and truthful upload fallback", async () => {
  const read = (name) =>
    readFile(new URL("../src/" + name, import.meta.url), "utf8");
  const [app, thumb, audio, reference, outbound, paragraph] = await Promise.all([
    read("App.tsx"),
    read("components/AssetThumb.tsx"),
    read("components/AudioThumbnail.tsx"),
    read("features/editing/ReferenceMedia.tsx"),
    read("features/AssetOutboundDialog.tsx"),
    read("features/editing/ParagraphCard.tsx"),
  ]);
  assert.match(app, /bindDragCleanup\(window, resetDragging\)/);
  assert.match(
    app,
    /useEffect\(resetDragging, \[view, filter, resetDragging\]\)/,
  );
  assert.match(app, /setTimeout\(resetDragging, 1200\)/);
  assert.match(thumb, /<AudioThumbnail asset=\{asset\}/);
  assert.match(reference, /<AudioThumbnail asset=\{asset\}/);
  assert.match(thumb, /writeMediaFileDrag\(e.dataTransfer, asset\)/);
  assert.match(thumb, /bindDragCleanup\(window, \(\) => setDropHover\(false\)\)/);
  assert.match(paragraph, /bindDragCleanup\(window, \(\) => \{\s*setDropping\(false\)/);
  assert.match(audio, /IntersectionObserver/);
  assert.match(audio, /controller.abort\(\)/);
  assert.match(audio, /非真实波形/);
  assert.doesNotMatch(audio, /AudioContext|Math.random/);
  assert.match(outbound, /直接跨网页拖音频不保证被接收/);
});
