/** A readable cross-platform filename, with room for a unique suffix. */
export function workflowFilename(name: string): string {
  const cleaned = name.trim()
    .replace(/[\\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\.+|[. ]+$/g, "")
    .trim();
  let stem = "";
  for (const character of cleaned) {
    if (Buffer.byteLength(stem + character, "utf8") > 180) break;
    stem += character;
  }
  stem = stem.replace(/[. ]+$/, "") || "workflow";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return `${stem}.workflow.json`;
}
