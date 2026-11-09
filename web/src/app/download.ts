/** Saves text the application just received as a file, without keeping it anywhere in the browser. */
export function saveFile(filename: string, content: string, type: string) {
  // Reading a response as text drops the byte order mark that makes spreadsheets read UTF-8; put it back.
  const body =
    type.startsWith("text/csv") && !content.startsWith("\uFEFF")
      ? `\uFEFF${content}`
      : content;
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // A large file may still be handed to the download manager when the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
