// The changelog entry a sync PR adds: one top-level item under `## [Unreleased]` → `### Changed`, so the updated
// copies count in the consumer's next daily release. Pure text transformation; the sync rebuilds its commit from
// the consumer's base branch every time, so the entry is added to an unmodified file and never doubles.

const UNRELEASED = "## [Unreleased]";

/** `text` with `item` (one line, without the leading `- `) added under `## [Unreleased]` → `### Changed`. */
export function addChangedItem(text: string, item: string): string {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	const entry = `- ${item}`;
	let start = lines.findIndex((l) => l.trim() === UNRELEASED);
	if (start < 0) {
		const firstVersion = lines.findIndex((l) => l.startsWith("## "));
		const at = firstVersion < 0 ? lines.length : firstVersion;
		lines.splice(at, 0, UNRELEASED, "");
		start = at;
	}
	let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
	if (end < 0) end = lines.length;
	const changed = lines.findIndex((l, i) => i > start && i < end && l.trim() === "### Changed");
	if (changed >= 0) {
		const next = lines[changed + 1];
		const at = next !== undefined && next.trim() === "" ? changed + 2 : changed + 1;
		lines.splice(at, 0, entry);
		if (next === undefined || next.trim() !== "") lines.splice(at, 0, "");
		return lines.join(eol);
	}
	let at = end;
	while (at - 1 > start && lines[at - 1]?.trim() === "") at--;
	const after = lines[at];
	lines.splice(at, 0, "", "### Changed", "", entry);
	if (after !== undefined && after.trim() !== "") lines.splice(at + 4, 0, "");
	return lines.join(eol);
}
