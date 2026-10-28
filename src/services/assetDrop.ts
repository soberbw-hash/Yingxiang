export function droppedMediaUrl(data: Pick<DataTransfer, "getData">): string {
  const html = data.getData("text/html");
  const media = html
    ? new DOMParser()
        .parseFromString(html, "text/html")
        .querySelector("img[src],video[src],audio[src],video source[src],audio source[src]")
        ?.getAttribute("src")
    : "";
  const uri = data
    .getData("text/uri-list")
    .split(/\r?\n/)
    .find((line) => line.trim() && !line.startsWith("#"));
  const plain = data.getData("text/plain").trim();
  const candidate = (media || uri || plain || "").trim();
  return /^https?:\/\//i.test(candidate) ? candidate : "";
}
