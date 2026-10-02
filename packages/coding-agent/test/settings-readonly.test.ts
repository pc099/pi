import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

describe("immutable project settings", () => {
	let root: string;
	let path: string;
	let storage: FileSettingsStorage;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-settings-readonly-"));
		mkdirSync(join(root, ".pi"));
		path = join(root, ".pi/settings.json");
		writeFileSync(path, JSON.stringify({ extensions: ["./guard.ts"], skills: ["./doctrine"] }));
		storage = new FileSettingsStorage(root, join(root, "agent"));
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	for (const code of ["EROFS", "EACCES"]) {
		it(`loads existing profile after ${code} without creating a lock`, () => {
			const error = Object.assign(new Error("fixture read-only lock refusal"), { code });
			const lock = vi.spyOn(lockfile, "lockSync").mockImplementation(() => {
				throw error;
			});
			const before = readFileSync(path, "utf8");
			const manager = SettingsManager.create(root, join(root, "agent"));
			expect(manager.getExtensionPaths()).toEqual(["./guard.ts"]);
			expect(manager.getSkillPaths()).toEqual(["./doctrine"]);
			expect(manager.drainErrors()).toEqual([]);
			expect(lock).toHaveBeenCalledTimes(1);
			expect(existsSync(`${path}.lock`)).toBe(false);
			expect(readFileSync(path, "utf8")).toBe(before);
		});

		it(`rejects every write intent after ${code}, including identical bytes`, () => {
			const error = Object.assign(new Error("fixture read-only lock refusal"), { code });
			vi.spyOn(lockfile, "lockSync").mockImplementation(() => {
				throw error;
			});
			const before = readFileSync(path, "utf8");
			for (const next of [before, "{}", ""]) {
				const callback = vi.fn(() => next);
				expect(() => storage.withLock("project", callback)).toThrow(error);
				expect(callback).toHaveBeenCalledTimes(1);
				expect(readFileSync(path, "utf8")).toBe(before);
				expect(existsSync(`${path}.lock`)).toBe(false);
			}
		});
	}

	it("preserves normal writable read/write locking and release", () => {
		const callback = vi.fn((current: string | undefined) => {
			expect(current).toBe(readFileSync(path, "utf8"));
			expect(existsSync(`${path}.lock`)).toBe(true);
			return "{}";
		});
		storage.withLock("project", callback);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(readFileSync(path, "utf8")).toBe("{}");
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	it("retains contention retries and never invokes a callback without its lock", () => {
		const error = Object.assign(new Error("fixture active writer"), { code: "ELOCKED" });
		const lock = vi.spyOn(lockfile, "lockSync").mockImplementation(() => {
			throw error;
		});
		const callback = vi.fn(() => undefined);
		expect(() => storage.withLock("project", callback)).toThrow(error);
		expect(lock).toHaveBeenCalledTimes(10);
		expect(callback).not.toHaveBeenCalled();
	});

	it("propagates unrelated lock failures and read-only callback failures", () => {
		const callback = vi.fn(() => undefined);
		const other = Object.assign(new Error("fixture I/O error"), { code: "EIO" });
		const lock = vi.spyOn(lockfile, "lockSync").mockImplementation(() => {
			throw other;
		});
		expect(() => storage.withLock("project", callback)).toThrow(other);
		expect(callback).not.toHaveBeenCalled();
		lock.mockImplementation(() => {
			throw Object.assign(new Error("readonly"), { code: "EROFS" });
		});
		const parse = new Error("fixture parse failure");
		expect(() =>
			storage.withLock("project", () => {
				throw parse;
			}),
		).toThrow(parse);
	});
});
