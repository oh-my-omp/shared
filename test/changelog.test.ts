import { describe, expect, test } from "bun:test";
import { addChangedItem } from "../lib/changelog.ts";

const ITEM = "Updated the shared copy of `i18n.ts` to oh-my-omp/shared@abc1234.";

describe("addChangedItem", () => {
	test("an empty Unreleased section gains a Changed list before the next version", () => {
		const before = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-11-01\n\n### Added\n\n- a\n";
		expect(addChangedItem(before, ITEM)).toBe(
			`# Changelog\n\n## [Unreleased]\n\n### Changed\n\n- ${ITEM}\n\n## [1.0.0] - 2026-11-01\n\n### Added\n\n- a\n`,
		);
	});

	test("an existing Changed list in Unreleased gets the item, other categories and versions stay", () => {
		const before = "## [Unreleased]\n\n### Added\n\n- x\n\n### Changed\n\n- y\n\n## [1.0.0] - 2026-11-01\n\n### Changed\n\n- z\n";
		expect(addChangedItem(before, ITEM)).toBe(
			`## [Unreleased]\n\n### Added\n\n- x\n\n### Changed\n\n- ${ITEM}\n- y\n\n## [1.0.0] - 2026-11-01\n\n### Changed\n\n- z\n`,
		);
	});

	test("a Changed heading of a released version is never used", () => {
		const before = "## [Unreleased]\n\n### Added\n\n- x\n\n## [1.0.0] - 2026-11-01\n\n### Changed\n\n- z\n";
		const after = addChangedItem(before, ITEM);
		expect(after).toBe(
			`## [Unreleased]\n\n### Added\n\n- x\n\n### Changed\n\n- ${ITEM}\n\n## [1.0.0] - 2026-11-01\n\n### Changed\n\n- z\n`,
		);
	});

	test("Unreleased as the last section, file ending in a newline", () => {
		expect(addChangedItem("## [Unreleased]\n\n### Fixed\n\n- f\n", ITEM)).toBe(
			`## [Unreleased]\n\n### Fixed\n\n- f\n\n### Changed\n\n- ${ITEM}\n`,
		);
	});

	test("a changelog without Unreleased gets one above the first version", () => {
		expect(addChangedItem("# Changelog\n\n## [0.1.0] - 2026-11-01\n\n- a\n", ITEM)).toBe(
			`# Changelog\n\n## [Unreleased]\n\n### Changed\n\n- ${ITEM}\n\n## [0.1.0] - 2026-11-01\n\n- a\n`,
		);
	});

	test("CRLF line endings are kept", () => {
		expect(addChangedItem("## [Unreleased]\r\n\r\n## [1.0.0] - 2026-11-01\r\n", ITEM)).toBe(
			`## [Unreleased]\r\n\r\n### Changed\r\n\r\n- ${ITEM}\r\n\r\n## [1.0.0] - 2026-11-01\r\n`,
		);
	});
});
