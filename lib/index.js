import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { execSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
//#region src/commands.ts
const VALID_STATES = [
	"STARTING",
	"IDLE",
	"THINKING",
	"WORKING",
	"CODING",
	"RUNNING_COMMAND",
	"WAITING_FOR_USER",
	"SUCCESS",
	"ERROR",
	"SLEEPING"
];
/**
* Register the `/pet` command if the context exposes `commands`.
* Returns a disposer (no-op if the capability is absent).
*/
function registerPetCommand(ctx, host) {
	if (!ctx.commands || typeof ctx.commands.register !== "function") return () => {};
	ctx.commands.register({
		name: "pet",
		description: "Simulate a desktop-pet state for manual verification.",
		handler: async (invocation) => {
			const arg = (invocation.rawInput ?? "").trim().toUpperCase();
			if (arg === "" || arg === "RESET" || arg === "CLEAR") {
				host.resetDebugState();
				return {
					kind: "success",
					text: "Pet debug state reset."
				};
			}
				if (arg === "ON" || arg === "SHOW" || arg === "OPEN") {
				await host.setEnabled(true);
				return {
					kind: "success",
					text: "蕾米埃尔回来了。"
				};
			}
			if (arg === "OFF" || arg === "HIDE" || arg === "CLOSE") {
				await host.setEnabled(false);
				return {
					kind: "success",
					text: "蕾米埃尔已完全关闭。在 DSH 会话里发 /pet on 就能把她叫回来。"
				};
			}
			if (!VALID_STATES.includes(arg)) return {
				kind: "error",
				text: `Unknown state "${arg}". Valid states: ${VALID_STATES.join(", ")}`
			};
			host.setDebugState(arg);
			return {
				kind: "success",
				text: `Pet debug state set to ${arg}.`
			};
		}
	});
	return () => {};
}
//#endregion
//#region src/config.ts
/**
* Plugin configuration.
*
* The entry `Config` schema is a Schemastery object (satisfying the Standard
* Schema interface Cordis expects) so `cordis.yml` can provide overrides and
* invalid values fail loudly at load time. The smaller {@link PetSettings}
* schema is the user-editable subset registered as a settings namespace so the
* Web configuration page can change it at runtime; the entry config fields
* (`enabled`, `petScale`, `petId`) are that namespace's composition `base`.
*
* Position persistence lives in a private local file (not the harness config
* service), so the pet works without any optional Harness storage service.
*/
/** Settings namespace name (spelled identically in the client package). */
const DESKTOP_PET_SETTINGS_NS = "desktop-pet";
const PetSettingsSchema = z.object({
	enabled: z.boolean().default(true),
	petScale: z.number().step(.25).min(.5).max(4).default(1),
	petId: z.string().default("text"),
	hideWhenIdle: z.boolean().default(false),
	availablePets: z.array(z.object({
		id: z.string(),
		displayName: z.string()
	})).default([]),
	petAction: z.object({
		kind: z.union(["importFolder", "importPetdex"]),
		requestId: z.string(),
		payload: z.object({ slug: z.string() }).default(void 0)
	}).default(null),
	importResult: z.object({
		ok: z.boolean(),
		code: z.string(),
		requestId: z.string(),
		petId: z.string().default(void 0),
		detail: z.string().default(void 0),
		at: z.number()
	}).default(null)
});
const Config = z.object({
	enabled: z.boolean().default(true),
	alwaysOnTop: z.boolean().default(true),
	petScale: z.number().step(.25).min(.5).max(4).default(1),
	petId: z.string().default("text"),
	hideWhenIdle: z.boolean().default(false),
	animationEnabled: z.boolean().default(true),
	idleFrequencySec: z.natural().min(8).default(20),
	clickThrough: z.boolean().default(false),
	startSleeping: z.boolean().default(false),
	animationSpeed: z.number().min(.25).max(4).default(1)
});
//#endregion
//#region src/core/PetStateResolver.ts
/**
* Classify a tool name into a more specific semantic state when the harness
* exposes it. The mapping is conservative and defaults to `WORKING`.
*/
function classifyTool(name) {
	if (!name) return "WORKING";
	const lower = name.toLowerCase();
	if (/edit|write|patch|update-file|apply|replace/i.test(lower)) return "CODING";
	if (/bash|shell|run|exec|command|terminal|python|node/i.test(lower)) return "RUNNING_COMMAND";
	return "WORKING";
}
/**
* Resolve a single normalized event into a state transition.
*/
function resolveEvent(event) {
	switch (event.type) {
		case "session.started": return {
			state: "STARTING",
			flash: true
		};
		case "session.idle": return {
			state: "IDLE",
			flash: false
		};
		case "agent.thinking": return {
			state: "THINKING",
			flash: false
		};
		case "agent.outputting": return {
			state: "WRITING",
			flash: false
		};
		case "tool.started": return {
			state: classifyTool(String(event.metadata?.toolName ?? "")),
			flash: false
		};
		case "tool.completed": return {
			state: "IDLE",
			flash: false
		};
		case "user_input.required": return {
			state: "WAITING_FOR_USER",
			flash: false
		};
		case "user_input.resolved": return {
			state: "IDLE",
			flash: false
		};
		case "task.completed": return {
			state: "SUCCESS",
			flash: true
		};
		case "task.failed": return {
			state: "ERROR",
			flash: true
		};
		default: return {
			state: "IDLE",
			flash: false
		};
	}
}
//#endregion
//#region src/core/TaskStateRegistry.ts
/** Priority used to collapse many task states into one global state. */
const STATE_PRIORITY = {
	WAITING_FOR_USER: 60,
	ERROR: 50,
	WORKING: 40,
	CODING: 40,
	RUNNING_COMMAND: 40,
	WRITING: 35,
	THINKING: 30,
	SUCCESS: 20,
	STARTING: 10,
	IDLE: 0,
	SLEEPING: -10
};
//#endregion
//#region src/core/PetStateMachine.ts
/**
* The pet's activity state machine.
*
* Responsibilities (all deterministic, all harness-independent):
*   - fold per-task resolved states into one global state by priority;
*   - suppress duplicate transitions;
*   - hold the current state for a minimum duration unless a higher-priority
*     state interrupts;
*   - expire transient states (`SUCCESS` / `ERROR` / `STARTING` / `THINKING`);
*   - fall back to `SLEEPING` after a long quiet period.
*
* The machine only exposes a getter and an `onEvent` input; it never touches
* animation or rendering directly.
*/
const realClock$1 = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle)
};
/** Defaults tuned for an ambient indicator: responsive but not jittery. */
const DEFAULTS = {
	minStateMs: 250,
	flashMs: 2e3,
	thinkingMs: 2e3,
	sleepAfterMs: 6e4
};
/**
* Transient/terminal states a late `session.idle` must not overwrite: they
* own their own expiry or are higher-priority facts the agent-status signal
* is too coarse to revoke.
*/
const IDLE_PROTECTED_STATES = /* @__PURE__ */ new Set([
	"STARTING",
	"WAITING_FOR_USER",
	"SUCCESS",
	"ERROR"
]);
var PetStateMachine = class {
	clock;
	minStateMs;
	flashMs;
	thinkingMs;
	sleepAfterMs;
	onChange;
	tasks = /* @__PURE__ */ new Map();
	expiryTimers = /* @__PURE__ */ new Map();
	current = "IDLE";
	currentSince;
	lastActivityAt;
	recomputeTimer;
	sleepTimer;
	disposed = false;
	constructor(options = {}) {
		this.clock = options.clock ?? realClock$1;
		this.minStateMs = options.minStateMs ?? DEFAULTS.minStateMs;
		this.flashMs = options.flashMs ?? DEFAULTS.flashMs;
		this.thinkingMs = options.thinkingMs ?? DEFAULTS.thinkingMs;
		this.sleepAfterMs = options.sleepAfterMs ?? DEFAULTS.sleepAfterMs;
		this.onChange = options.onChange;
		const now = this.clock.now();
		this.currentSince = now;
		this.lastActivityAt = now;
		this.scheduleSleepCheck();
	}
	get state() {
		return this.current;
	}
	/** The task id an event belongs to (for concurrent-agent isolation). */
	taskIdOf(event) {
		return event.taskId ?? event.sessionId ?? "default";
	}
	/**
	* Consume one normalized event. Resolution + expiry + priority collapse are
	* all handled here; the caller just forwards events.
	*/
	onEvent(event) {
		if (this.disposed) return;
		const { state, flash } = resolveEvent(event);
		const taskId = this.taskIdOf(event);
		const now = this.clock.now();
		if (state !== "IDLE" && state !== "SLEEPING") this.lastActivityAt = now;
		const existing = this.tasks.get(taskId);
		if (state === "IDLE" && existing !== void 0 && IDLE_PROTECTED_STATES.has(existing.state)) return;
		this.tasks.set(taskId, {
			state,
			updatedAt: now
		});
		this.clearExpiry(taskId);
		if (flash) this.scheduleExpiry(taskId, this.flashMs);
		else if (state === "THINKING" || state === "WRITING") this.scheduleExpiry(taskId, this.thinkingMs);
		this.recompute();
	}
	/** Remove a task (e.g. when its session ends) and re-resolve. */
	removeTask(taskId) {
		this.clearExpiry(taskId);
		this.tasks.delete(taskId);
		this.recompute();
	}
	clearExpiry(taskId) {
		const timer = this.expiryTimers.get(taskId);
		if (timer !== void 0) {
			this.clock.clearTimeout(timer);
			this.expiryTimers.delete(taskId);
		}
	}
	scheduleExpiry(taskId, ms) {
		const timer = this.clock.setTimeout(() => {
			this.expiryTimers.delete(taskId);
			const task = this.tasks.get(taskId);
			if (task && (task.state === "SUCCESS" || task.state === "ERROR" || task.state === "STARTING" || task.state === "THINKING" || task.state === "WRITING")) {
				this.tasks.set(taskId, {
					state: "IDLE",
					updatedAt: this.clock.now()
				});
				this.recompute();
			}
		}, ms);
		this.expiryTimers.set(taskId, timer);
	}
	targetState() {
		let best = "IDLE";
		let bestPriority = STATE_PRIORITY.IDLE;
		for (const task of this.tasks.values()) {
			const priority = STATE_PRIORITY[task.state];
			if (priority > bestPriority) {
				best = task.state;
				bestPriority = priority;
			}
		}
		if (best === "IDLE" && this.clock.now() - this.lastActivityAt >= this.sleepAfterMs) return "SLEEPING";
		return best;
	}
	/** Re-evaluate the quiet → SLEEPING fallback after the idle window elapses. */
	scheduleSleepCheck() {
		if (this.sleepTimer !== void 0) this.clock.clearTimeout(this.sleepTimer);
		this.sleepTimer = void 0;
		if (this.current !== "IDLE") return;
		const remaining = this.sleepAfterMs - (this.clock.now() - this.lastActivityAt);
		this.sleepTimer = this.clock.setTimeout(() => {
			this.sleepTimer = void 0;
			if (this.disposed) return;
			this.recompute();
		}, Math.max(0, remaining));
	}
	recompute() {
		if (this.disposed) return;
		const target = this.targetState();
		const now = this.clock.now();
		if (target === this.current) {
			if (this.recomputeTimer !== void 0) {
				this.clock.clearTimeout(this.recomputeTimer);
				this.recomputeTimer = void 0;
			}
			this.scheduleSleepCheck();
			return;
		}
		const higherOrEqual = STATE_PRIORITY[target] >= STATE_PRIORITY[this.current];
		const heldLongEnough = now - this.currentSince >= this.minStateMs;
		if (higherOrEqual || heldLongEnough) {
			this.commit(target);
			this.scheduleSleepCheck();
			return;
		}
		if (this.recomputeTimer !== void 0) return;
		const remaining = this.minStateMs - (now - this.currentSince);
		this.recomputeTimer = this.clock.setTimeout(() => {
			this.recomputeTimer = void 0;
			this.recompute();
		}, Math.max(0, remaining));
	}
	commit(state) {
		this.current = state;
		this.currentSince = this.clock.now();
		this.onChange?.(state);
	}
	dispose() {
		this.disposed = true;
		if (this.recomputeTimer !== void 0) {
			this.clock.clearTimeout(this.recomputeTimer);
			this.recomputeTimer = void 0;
		}
		if (this.sleepTimer !== void 0) {
			this.clock.clearTimeout(this.sleepTimer);
			this.sleepTimer = void 0;
		}
		for (const timer of this.expiryTimers.values()) this.clock.clearTimeout(timer);
		this.expiryTimers.clear();
		this.tasks.clear();
	}
};
//#endregion
//#region src/paths.ts
/**
* Package-root-relative asset paths.
*
* This module lives exactly one directory below the package root in both
* source (`src/`) and built output (`lib/`), so a single relative URL resolves
* identically before and after bundling. Do NOT compute asset paths from
* deeper modules: their `import.meta.url` depth changes once inlined into
* `lib/index.js`.
*/
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
/** Bundled assets directory (`assets/`). */
const ASSETS_DIR = join(PACKAGE_ROOT, "assets");
/** Pet directories (`assets/pets/<id>/`). */
const PETS_DIR = join(ASSETS_DIR, "pets");
/** Neutralino frontend app (`assets/neutralino/`). */
const NEUTRALINO_APP_DIR = join(ASSETS_DIR, "neutralino");
/** Downloaded Neutralino runtime binaries (`runtime/`, git-ignored). */
const RUNTIME_DIR = join(PACKAGE_ROOT, "runtime");
/**
* Per-user data directory (`~/.dsh/desktop-pet/`), shared with the window
* position persistence so user-owned state lives outside the installed
* package and survives npm upgrades/reinstalls.
*/
const USER_DATA_DIR = join(homedir(), ".dsh", "desktop-pet");
/** User-imported pets (`~/.dsh/desktop-pet/pets/<id>/`). */
const USER_PETS_DIR = join(USER_DATA_DIR, "pets");
//#endregion
//#region src/imports.ts
/**
* Pet import: validate a pet directory, copy it into the per-user pets
* directory, and drive the third-party Petdex CLI (`npx petdex install`).
*
* Import targets are user-owned (`~/.dsh/desktop-pet/pets/<id>/`), so imported
* pets survive npm upgrades of the plugin. All failures surface as
* machine-readable error codes the client translates into UI copy — the host
* never mixes display language into its results.
*/
/** Where the Petdex CLI downloads pets (`~/.petdex/pets/<slug>/`). */
function petdexInstallDir() {
	return join(homedir(), ".petdex", "pets");
}
/** Legacy install location documented by older guides (`~/.codex/pets/<slug>/`). */
function codexInstallDir() {
	return join(homedir(), ".codex", "pets");
}
/** Read and validate a pet directory's manifest, returning its key fields. */
function readManifest(directory) {
	const manifestPath = join(directory, "pet.json");
	let raw;
	try {
		raw = readFileSync(manifestPath, "utf8");
	} catch {
		throw importFailure("no-pet-json");
	}
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		throw importFailure("invalid-manifest");
	}
	if (typeof value !== "object" || value === null) throw importFailure("invalid-manifest");
	const record = value;
	if (typeof record.id !== "string" || record.id.length === 0) throw importFailure("missing-id");
	const spritesheetPath = typeof record.spritesheetPath === "string" && record.spritesheetPath.length > 0 ? record.spritesheetPath : void 0;
	const rawAnims = record.animations;
	const animations = rawAnims && typeof rawAnims === "object" && !Array.isArray(rawAnims) ? Object.fromEntries(Object.entries(rawAnims).filter(([, v]) => typeof v === "string" && v.length > 0)) : void 0;
	if (spritesheetPath === void 0 && (animations === void 0 || Object.keys(animations).length === 0)) throw importFailure("missing-spritesheet-path");
	if (spritesheetPath !== void 0 && basename(spritesheetPath) !== spritesheetPath) throw importFailure("unsafe-spritesheet-path");
	const displayName = typeof record.displayName === "string" && record.displayName.length > 0 ? record.displayName : record.id;
	const cell = Array.isArray(record.cell) && record.cell.length === 2 && record.cell.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0) ? {
		width: record.cell[0],
		height: record.cell[1]
	} : void 0;
	return {
		id: record.id,
		displayName,
		spritesheetPath,
		animations,
		cell
	};
}
/** Validate that `spritesheetPath` exists next to `pet.json` and is an image. */
function assertSpritesheet(directory, spritesheetPath) {
	const file = join(directory, spritesheetPath);
	let stat;
	try {
		stat = statSync(file);
	} catch {
		throw importFailure("missing-spritesheet-file");
	}
	if (!stat.isFile()) throw importFailure("missing-spritesheet-file");
	const ext = basename(spritesheetPath).toLowerCase();
	if (!ext.endsWith(".webp") && !ext.endsWith(".png")) throw importFailure("missing-spritesheet-file");
}
/** Copy only the pet files (manifest + sprite sheet) into a target root. */
function copyIntoPetsRoot(id, source, spritesheetPath, targetRoot) {
	const dest = join(targetRoot, id);
	if (existsSync(dest)) {
		let valid = false;
		try {
			assertSpritesheet(dest, readManifest(dest).spritesheetPath);
			valid = true;
		} catch {}
		if (valid) throw importFailure("already-present");
		throw importFailure("duplicate-id");
	}
	try {
		mkdirSync(dest, { recursive: true });
		copyFileSync(join(source, "pet.json"), join(dest, "pet.json"));
		copyFileSync(join(source, spritesheetPath), join(dest, spritesheetPath));
	} catch (error) {
		try {
			rmSync(dest, {
				recursive: true,
				force: true
			});
		} catch {}
		throw importFailure("copy-failed", error?.message);
	}
}
function importFailure(code, detail) {
	return Object.assign(new Error(code), {
		code,
		detail
	});
}
/**
* Import a pet from a local directory: validate the manifest and sprite sheet,
* then copy the pet files into the target pets root.
*
* @param sourceDir - directory containing `pet.json` + a sprite sheet.
* @param targetRoot - destination pets root (defaults to the user pets dir).
* @returns the imported pet's id and display name.
*/
function importPetFromDirectory(sourceDir, targetRoot = USER_PETS_DIR) {
	let stat;
	try {
		stat = statSync(sourceDir);
	} catch {
		return {
			ok: false,
			code: "source-not-directory"
		};
	}
	if (!stat.isDirectory()) return {
		ok: false,
		code: "source-not-directory"
	};
	let manifest;
	try {
		manifest = readManifest(sourceDir);
		assertSpritesheet(sourceDir, manifest.spritesheetPath);
	} catch (error) {
		const failure = error;
		return {
			ok: false,
			code: failure.code,
			detail: failure.detail
		};
	}
	try {
		copyIntoPetsRoot(manifest.id, sourceDir, manifest.spritesheetPath, targetRoot);
	} catch (error) {
		const failure = error;
		if (failure.code === "already-present") return {
			ok: true,
			code: "already-present",
			petId: manifest.id,
			displayName: manifest.displayName
		};
		return {
			ok: false,
			code: failure.code,
			detail: failure.detail
		};
	}
	return {
		ok: true,
		code: "ok",
		petId: manifest.id,
		displayName: manifest.displayName
	};
}
/** Locate a downloaded Petdex pet directory (new + legacy install locations). */
function findPetdexPet(slug) {
	for (const root of [petdexInstallDir(), codexInstallDir()]) {
		const candidate = join(root, slug);
		if (existsSync(join(candidate, "pet.json"))) return candidate;
	}
}
/**
* Import a pet from the Petdex community CLI. Runs `npx --yes petdex install
* <slug>` (the CLI confirms the slug exists and downloads the pet), then
* copies the downloaded directory into the target pets root.
*
* The slug is passed as a plain argv entry (no shell), so it cannot inject
* shell commands.
*/
function importPetFromPetdex(slug, targetRoot = USER_PETS_DIR, spawnFn = spawn) {
	const trimmed = slug.trim();
	if (trimmed.length === 0) return Promise.resolve({
		ok: false,
		code: "petdex-not-found",
		detail: "empty slug"
	});
	return new Promise((resolve) => {
		const isWindows = process.platform === "win32";
		let child;
		try {
			child = spawnFn(isWindows ? "npx.cmd" : "npx", [
				"--yes",
				"petdex",
				"install",
				trimmed
			], {
				cwd: tmpdir(),
				shell: isWindows,
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				]
			});
		} catch (error) {
			resolve({
				ok: false,
				code: "petdex-failed",
				detail: error?.message
			});
			return;
		}
		let stderr = "";
		let timedOut = false;
		child.stdout?.on("data", () => {});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, 12e4);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({
				ok: false,
				code: "petdex-failed",
				detail: error?.message
			});
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (timedOut) {
				resolve({
					ok: false,
					code: "petdex-failed",
					detail: "timed out after 120s"
				});
				return;
			}
			if (code !== 0) {
				resolve({
					ok: false,
					code: "petdex-failed",
					detail: stderr.trim().slice(0, 300) || `exit code ${code}`
				});
				return;
			}
			const downloaded = findPetdexPet(trimmed);
			if (!downloaded) {
				resolve({
					ok: false,
					code: "petdex-not-found"
				});
				return;
			}
			resolve(importPetFromDirectory(downloaded));
		});
	});
}
/** Whether `directory` holds a valid pet (manifest + sprite sheet). */
function isValidPet(directory) {
	try {
		assertSpritesheet(directory, readManifest(directory).spritesheetPath);
		return true;
	} catch {
		return false;
	}
}
/**
* Restore a missing or broken pet from a source copy (e.g. the Petdex
* download directory) after the user pets directory lost it. Used at startup
* so a `petId` that points at an absent directory self-heals instead of
* silently falling back to the bundled pet.
*
* A target that exists but is broken (partial copy) is removed first; a valid
* target is left untouched.
*/
function restorePetFromSource(petId, options = {}) {
	const targetRoot = options.targetRoot ?? USER_PETS_DIR;
	const target = join(targetRoot, petId);
	if (isValidPet(target)) return {
		restored: false,
		reason: "already-valid"
	};
	const roots = options.sourceRoots ?? [petdexInstallDir(), codexInstallDir()];
	let source;
	for (const root of roots) {
		const candidate = join(root, petId);
		if (existsSync(join(candidate, "pet.json"))) {
			source = candidate;
			break;
		}
	}
	if (!source) return {
		restored: false,
		reason: "no-source"
	};
	let manifest;
	try {
		manifest = readManifest(source);
		assertSpritesheet(source, manifest.spritesheetPath);
	} catch {
		return {
			restored: false,
			reason: "copy-failed"
		};
	}
	try {
		if (existsSync(target)) rmSync(target, {
			recursive: true,
			force: true
		});
	} catch {
		return {
			restored: false,
			reason: "copy-failed"
		};
	}
	try {
		copyIntoPetsRoot(petId, source, manifest.spritesheetPath, targetRoot);
		return { restored: true };
	} catch {
		return {
			restored: false,
			reason: "copy-failed"
		};
	}
}
//#endregion
//#region src/integration/capability-detection.ts
const PROBES = {
	commands: "commands",
	agents: "agents",
	approval: "approval",
	sessions: "sessions"
};
/**
* Probe a context for optional services. `ctx.get` returns `undefined` for an
* unprovided service, so a boolean presence check is sufficient.
*/
function detectCapabilities(ctx) {
	const result = {};
	for (const [name, service] of Object.entries(PROBES)) {
		let present = false;
		try {
			present = ctx.get(service) !== void 0;
		} catch {
			present = false;
		}
		result[name] = present;
	}
	return result;
}
//#endregion
//#region src/integration/event-mapping.ts
function asRecord(value) {
	return typeof value === "object" && value !== null ? value : null;
}
function readString(value) {
	return typeof value === "string" ? value : void 0;
}
function readSessionId(session) {
	const record = asRecord(session);
	if (!record) return void 0;
	return readString(record.id) ?? readString(record.sessionId);
}
function readEventType(event) {
	return readString(asRecord(event)?.type);
}
function event(timestamp, type, sessionId, metadata) {
	const normalized = {
		type,
		timestamp
	};
	if (sessionId !== void 0) normalized.sessionId = sessionId;
	if (metadata !== void 0) normalized.metadata = metadata;
	return normalized;
}
function turnEndReason(event) {
	const data = asRecord(event.data);
	const reason = asRecord(data?.reason) ?? data?.reason;
	if (typeof reason === "string") return reason;
	return readString(asRecord(reason)?.kind);
}
/**
* Map one `session/event` payload into a normalized event, or `null` when the
* event is not activity-relevant.
*
* @param session - the raw session object (read for `id` only).
* @param rawEvent - the raw `SessionEvent` envelope (`{ type, data, ... }`).
*/
function mapSessionEvent(session, rawEvent, timestamp = Date.now()) {
	const eventRecord = asRecord(rawEvent);
	if (!eventRecord) return null;
	const type = readEventType(rawEvent);
	if (!type) return null;
	const sessionId = readSessionId(session);
	switch (type) {
		case "turn/end": {
			const reason = turnEndReason(eventRecord);
			if (reason === "completed") return event(timestamp, "task.completed", sessionId);
			if (reason && reason !== "blocked" && reason !== "interrupted") return event(timestamp, "task.failed", sessionId, { reason });
			return null;
		}
		case "step/start": return event(timestamp, "agent.thinking", sessionId);
		case "tool/call": {
			const toolName = readString(asRecord(eventRecord.data)?.name);
			return event(timestamp, "tool.started", sessionId, toolName !== void 0 ? { toolName } : void 0);
		}
		case "tool/result": return event(timestamp, "tool.completed", sessionId);
		case "command/run": return event(timestamp, "tool.started", sessionId, { toolName: "command" });
		case "command/done": return null;
		case "assistant/message": return event(timestamp, "agent.outputting", sessionId);
		case "assistant/chunk": {
			const chunkType = readString(asRecord(asRecord(eventRecord.data)?.chunk)?.type);
			if (chunkType === "text-delta") return event(timestamp, "agent.outputting", sessionId);
			if (chunkType === "reasoning-delta" || chunkType === "tool-call-delta") return event(timestamp, "agent.thinking", sessionId);
			return null;
		}
		case "approval/asked": return event(timestamp, "user_input.required", sessionId);
		case "approval/decided": return event(timestamp, "user_input.resolved", sessionId);
		default: return null;
	}
}
/**
* Map an `agent/status` payload (`{ agent, status }`) into a normalized event.
*/
function mapAgentStatus(payload, timestamp = Date.now()) {
	const record = asRecord(payload);
	if (!record) return null;
	const status = readString(record.status);
	if (status !== "idle" && status !== "running") return null;
	if (status === "running") return null;
	const agent = asRecord(record.agent);
	return event(timestamp, "session.idle", readSessionId(agent) ?? readString(agent?.id));
}
//#endregion
//#region src/integration/HarnessBridge.ts
/**
* Build a bridge over a live Cordis context.
*
* The bridge subscribes to the stable `session/event` and `agent/status`
* events (both are part of the core Harness surface) and normalizes them.
* Optional richer signals (`approval/*` session events, tool names) are read
* defensively when present.
*/
function createHarnessBridge(ctx) {
	const log = ctx.logger("desktop-pet");
	const capabilities = detectCapabilities(ctx);
	const listeners = /* @__PURE__ */ new Set();
	const disposers = [];
	let started = false;
	function dispatch(event) {
		for (const listener of listeners) try {
			listener(event);
		} catch (error) {
			log.warn("pet event listener threw: %s", error?.message ?? String(error));
		}
	}
	function start() {
		if (started) return Promise.resolve();
		started = true;
		disposers.push(ctx.on("session/event", (session, event) => {
			const normalized = mapSessionEvent(session, event);
			if (normalized) dispatch(normalized);
		}, { global: true }));
		disposers.push(ctx.on("agent/status", (payload) => {
			const normalized = mapAgentStatus(payload);
			if (normalized) dispatch(normalized);
		}, { global: true }));
		log.debug("bridge started (%s)", Object.keys(capabilities).filter((k) => capabilities[k]).join(", ") || "no optional capabilities");
		return Promise.resolve();
	}
	async function stop() {
		if (!started) return;
		started = false;
		for (const dispose of disposers.splice(0)) try {
			dispose();
		} catch (error) {
			log.debug("dispose during stop failed: %s", error?.message ?? String(error));
		}
		listeners.clear();
		log.debug("bridge stopped");
	}
	function subscribe(callback) {
		listeners.add(callback);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			listeners.delete(callback);
		};
	}
	return {
		start,
		stop,
		subscribe,
		capabilities
	};
}
//#endregion
//#region src/persistence.ts
/**
* Private local persistence for the pet's window position.
*
* Deliberately independent of any Harness storage service: the pet reads and
* writes a single JSON file under the user's home directory so it works
* without optional plugins. All I/O is best-effort — failures are ignored so
* a missing/readonly path can never break the pet or Harness.
*/
const DIR = join(homedir(), ".dsh", "desktop-pet");
const FILE = join(DIR, "position.json");
function safeDir() {
	try {
		mkdirSync(DIR, { recursive: true });
	} catch {}
}
function loadPosition() {
	try {
		const raw = readFileSync(FILE, "utf8");
		const value = JSON.parse(raw);
		if (typeof value.x === "number" && typeof value.y === "number") return {
			x: value.x,
			y: value.y
		};
		return null;
	} catch {
		return null;
	}
}
function savePosition(position) {
	try {
		safeDir();
		writeFileSync(FILE, JSON.stringify(position), "utf8");
	} catch {}
}
function startFullscreenWatcher(onChange) {
	if (process.platform !== "win32") return () => {};
	const script = join(PACKAGE_ROOT, "scripts", "fullscreen-watch.ps1");
	if (!existsSync(script)) return () => {};
	const logFile = join(tmpdir(), "dsh-pet-fs.log");
	const logLine = (text) => {
		try {
			appendFileSync(logFile, (/* @__PURE__ */ new Date()).toISOString() + " " + text + "\n");
		} catch {}
	};
	let stopped = false;
	let last = null;
	let child;
	let restartTimer;
	const start = () => {
		if (stopped) return;
		try {
			child = spawn("powershell.exe", [
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				script
			], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
		} catch (error) {
			logLine("spawn-failed " + String(error));
			restartTimer = setTimeout(start, 5e3);
			return;
		}
		logLine("spawn pid=" + child.pid);
		let buffer = "";
		const consume = (chunk) => {
			buffer += chunk;
			let index;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (line !== "0" && line !== "1") continue;
				const full = line === "1";
				if (full === last) continue;
				logLine("change " + line);
				last = full;
				try {
					onChange(full);
				} catch {}
			}
			if (buffer.length > 4096) buffer = "";
		};
		try {
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", consume);
		} catch {}
		child.on("error", (error) => {
			logLine("child-error " + String(error));
		});
		child.on("exit", (code, signal) => {
			logLine("exit code=" + code + " signal=" + signal);
			if (!stopped) restartTimer = setTimeout(start, 3e3);
		});
	};
	start();
	return () => {
		stopped = true;
		clearTimeout(restartTimer);
		try {
			child?.kill();
		} catch {}
	};
}

const UI_FILE = join(DIR, "ui.json");
function loadUiState() {
	try {
		const value = JSON.parse(readFileSync(UI_FILE, "utf8"));
		if (typeof value.scale === "number" && value.scale >= 0.25 && value.scale <= 4) return { scale: value.scale };
		return null;
	} catch {
		return null;
	}
}
function saveUiState(state) {
	try {
		safeDir();
		writeFileSync(UI_FILE, JSON.stringify(state), "utf8");
	} catch {}
}
const CHAT_FILE = join(DIR, "chat.json");
function loadChatState() {
	try {
		const value = JSON.parse(readFileSync(CHAT_FILE, "utf8"));
		if (!value || typeof value !== "object") return null;
		const turns = Array.isArray(value.turns) ? value.turns.filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string").slice(-60) : [];
		return {
			mode: value.mode === "agent" ? "agent" : "chat",
			sessionId: typeof value.sessionId === "string" && value.sessionId.length > 0 ? value.sessionId : void 0,
			turns
		};
	} catch {
		return null;
	}
}
function saveChatState(state) {
	try {
		safeDir();
		writeFileSync(CHAT_FILE, JSON.stringify(state), "utf8");
	} catch {}
}
//#endregion
//#region src/pets.ts
/**
* Host-side pet catalog: scans the bundled `assets/pets/` directory plus the
* per-user `~/.dsh/desktop-pet/pets/` directory (where imported pets live) and
* resolves a pet directory into a sprite-sheet reference.
*
* User-imported pets shadow bundled pets with the same id: the user directory
* is scanned first so a user override wins, and imported pets survive npm
* upgrades (they live outside the installed package).
*/
/** Fallback entry used when no pet directory can be found on disk. */
const FALLBACK_ENTRY = {
	id: "text",
	displayName: "Text (test)"
};
/** Scan one pets directory for valid pet directories (helper, test-friendly). */
function scanDirectory(directory) {
	const entries = [];
	let names;
	try {
		names = readdirSync(directory, { withFileTypes: true });
	} catch {
		return entries;
	}
	for (const dirent of names) {
		if (!dirent.isDirectory()) continue;
		const id = dirent.name;
		try {
			const raw = readFileSync(join(directory, id, "pet.json"), "utf8");
			const manifest = JSON.parse(raw);
			if (typeof manifest.id !== "string" || manifest.id.length === 0) continue;
			const displayName = typeof manifest.displayName === "string" && manifest.displayName.length > 0 ? manifest.displayName : id;
			entries.push({
				id,
				displayName
			});
		} catch {}
	}
	return entries;
}
/**
* Scan a set of pets roots for valid pet directories, deduplicating by id with
* earlier roots winning. Used by {@link scanPets} and directly by tests.
*/
function scanPetsRoots(roots) {
	const entries = [];
	const seen = /* @__PURE__ */ new Set();
	for (const root of roots) for (const entry of scanDirectory(root)) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		entries.push(entry);
	}
	return entries;
}
/**
* Scan the pet catalog: the bundled `assets/pets/` directory plus the
* per-user imported-pets directory. The user directory wins on id conflicts
* (imported pets shadow bundled ones).
*
* A directory is a pet if it contains a readable `pet.json` with a string
* `id`. The directory name is the pet id. Invalid directories are skipped so
* one broken pet never takes down the catalog. Returns the fallback `text`
* entry when nothing valid is found.
*
* Synchronous so the settings namespace can be registered with the complete
* catalog as its `base` during the plugin's synchronous startup.
*
* @param directory - when given, scans only that directory (used by tests and
*   keeps the bundled path injectable); otherwise scans both roots.
*/
function scanPets(directory) {
	const entries = scanPetsRoots(directory !== void 0 ? [directory] : [USER_PETS_DIR, PETS_DIR]);
	return entries.length > 0 ? entries : [FALLBACK_ENTRY];
}
/** Resolve a pet id to its on-disk directory and root (user first). */
function petSource(petId) {
	const userDir = join(USER_PETS_DIR, petId);
	if (existsSync(join(userDir, "pet.json"))) return {
		directory: userDir,
		root: "user"
	};
	return {
		directory: join(PETS_DIR, petId),
		root: "bundled"
	};
}
/**
* Resolve a pet by id into its sprite sheet reference. The user directory is
* checked first, then the bundled one; the manifest is read live from disk.
* No pixel decoding happens here — the frontend loads the sheet itself.
* Throws if the directory or manifest is unreadable.
*/
async function resolvePetManifest(petId) {
	const { directory, root } = petSource(petId);
	const raw = readFileSync(join(directory, "pet.json"), "utf8");
	const manifest = JSON.parse(raw);
	if (typeof manifest.id !== "string" || manifest.id.length === 0) throw new Error(`pet.json in "${petId}" is missing a string "id" field`);
	const spritesheetPath = typeof manifest.spritesheetPath === "string" && manifest.spritesheetPath.length > 0 ? manifest.spritesheetPath : void 0;
	const rawAnims = manifest.animations;
	const animations = rawAnims && typeof rawAnims === "object" && !Array.isArray(rawAnims) ? Object.fromEntries(Object.entries(rawAnims).filter(([, v]) => typeof v === "string" && v.length > 0)) : void 0;
	if (spritesheetPath === void 0 && (animations === void 0 || Object.keys(animations).length === 0)) throw new Error(`pet.json in "${petId}" is missing a string "spritesheetPath" field`);
	const cell = Array.isArray(manifest.cell) && manifest.cell.length === 2 && manifest.cell.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0) ? {
		width: manifest.cell[0],
		height: manifest.cell[1]
	} : void 0;
	return {
		petId,
		spritesheetPath,
		animations,
		cell,
		root
	};
}
/**
* Whether a settings-side pet list matches a disk scan (same ids, same order).
* Used to detect a stale `availablePets` user layer (e.g. a pet whose
* directory was removed) so the host can write the scan back.
*/
function sameCatalog(a, b) {
	if (!Array.isArray(a)) return false;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id) return false;
	return true;
}
//#endregion
//#region src/settings.ts
/**
* Optional host settings integration.
*
* Registers the user-editable `desktop-pet` namespace against the Harness
* settings service when one exists, and applies the resolved section (schema
* defaults → composition base → user layer) to the pet through an `onApply`
* callback. When no settings service is present, it applies the composition
* entry once and returns a no-op disposer, so the pet still works without the
* optional settings seam.
*
* The namespace name and field schema are spelled here rather than importing
* `@deepseek-ai/dsh-settings`, so this independent plugin carries no runtime
* dependency on a Harness workspace package: a settings namespace is an
* ordinary lowercase-kebab string on the wire.
*/
/**
* Install the settings wiring.
*
* @param registrar - the settings service (already resolved), or undefined.
* @param base - the composition entry config, used as the namespace base layer.
* @param onApply - invoked with each resolved settings snapshot.
* @returns a handle to dispose the wiring and to write patches back.
*/
function installPetSettings(registrar, base, onApply) {
	if (!registrar) {
		onApply(base);
		return {
			dispose: () => {},
			update: () => {}
		};
	}
	const scope = registrar.register(DESKTOP_PET_SETTINGS_NS, PetSettingsSchema, { base });
	onApply(scope.get());
	return {
		dispose: scope.watch((next) => onApply(next)),
		update: (patch) => scope.update(patch)
	};
}
//#endregion
//#region src/visibility.ts
function shouldBeVisible(state, enabled, hideWhenIdle, debugState) {
	if (!enabled) return false;
	if (debugState !== void 0) return true;
	if (hideWhenIdle && (state === "IDLE" || state === "SLEEPING")) return false;
	return true;
}
//#endregion
//#region src/webui.ts
/**
* The dsh WebUI URL the pet opens when clicked.
*
* Harness prints "dsh web: http://127.0.0.1:<webServer.port>" from the
* web-app bundle; this mirrors that construction exactly. The `webServer`
* service exists only in web profiles, so a missing port yields undefined
* (the click-to-open action is then disabled).
*/
/** Loopback host used by the web-app bundle for the local Web runtime. */
const LOOPBACK_HOST = "127.0.0.1";
/** Build the WebUI URL from the live web server port, or undefined. */
function webUiUrl(port) {
	if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) return void 0;
	return `http://${LOOPBACK_HOST}:${port}`;
}
//#endregion
//#region src/core/types.ts
/** The mapping from a semantic state to the Codex renderer pose. */
const SEMANTIC_TO_CODEX = {
	STARTING: "waving",
	IDLE: "idle",
	THINKING: "running",
	WORKING: "running",
	CODING: "running",
	RUNNING_COMMAND: "running",
	WRITING: "review",
	WAITING_FOR_USER: "waiting",
	SUCCESS: "review",
	ERROR: "failed",
	SLEEPING: "idle"
};
/** The mapping from a semantic state to a native animation track (animation-mode pets). */
const SEMANTIC_TO_ANIM = {
	STARTING: "done",
	IDLE: "idle",
	THINKING: "thinking",
	WORKING: "tool",
	CODING: "tool",
	RUNNING_COMMAND: "tool",
	WRITING: "review",
	WAITING_FOR_USER: "waiting",
	SUCCESS: "done",
	ERROR: "tool",
	SLEEPING: "idle"
};
/**
* Per-frame durations baked into the Codex renderer. Rows are indexed in
* sprite-sheet row order (row 0 = `idle` … row 8 = `review`).
*/
const ANIMATION_ROWS = [
	{
		state: "idle",
		durations: [
			280,
			110,
			110,
			140,
			140,
			320
		]
	},
	{
		state: "running-right",
		durations: [
			120,
			120,
			120,
			120,
			120,
			120,
			120,
			220
		]
	},
	{
		state: "running-left",
		durations: [
			120,
			120,
			120,
			120,
			120,
			120,
			120,
			220
		]
	},
	{
		state: "waving",
		durations: [
			140,
			140,
			140,
			280
		]
	},
	{
		state: "jumping",
		durations: [
			140,
			140,
			140,
			140,
			280
		]
	},
	{
		state: "failed",
		durations: [
			140,
			140,
			140,
			140,
			140,
			140,
			140,
			240
		]
	},
	{
		state: "waiting",
		durations: [
			150,
			150,
			150,
			150,
			150,
			260
		]
	},
	{
		state: "running",
		durations: [
			120,
			120,
			120,
			120,
			120,
			220
		]
	},
	{
		state: "review",
		durations: [
			150,
			150,
			150,
			150,
			150,
			280
		]
	}
];
/** Map from a renderer state to its animation row definition. */
function animationRowFor(state) {
	return ANIMATION_ROWS.find((row) => row.state === state);
}
/**
* Derive the pixel rectangle of frame `index` for a given state row.
* Frames are laid out row-major, left-to-right: frame `i` occupies
* `(i * CELL_WIDTH, rowIndex * CELL_HEIGHT)`.
*/
function frameRect(state, index) {
	const row = animationRowFor(state);
	if (!row) throw new Error(`Unknown Codex pet state: ${state}`);
	const rowIndex = ANIMATION_ROWS.indexOf(row);
	const frameCount = row.durations.length;
	return {
		x: (index % frameCount + frameCount) % frameCount * 192,
		y: rowIndex * 208,
		width: 192,
		height: 208
	};
}
//#endregion
//#region src/renderer/FrameDecoder.ts
/**
* Pure frame slicing and scaling.
*
* Converts a decoded Codex atlas into individual frames at the requested
* display scale. Everything here is deterministic and unit-testable; the
* window backends only receive a finished {@link PetFrame} to present.
*/
/**
* Derive the render directive for a given pose and frame index. Pure and
* unit-testable; mirrors {@link sliceFrame} but carries coordinates instead
* of copied pixels.
*/
function frameDirective(state, index) {
	const rect = frameRect(state, index);
	return {
		pose: state,
		frameIndex: index,
		sx: rect.x,
		sy: rect.y,
		sw: rect.width,
		sh: rect.height
	};
}
//#endregion
//#region src/renderer/AnimationController.ts
const realClock = {
	now: () => Date.now(),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle)
};
var AnimationController = class {
	clock;
	onFrame;
	state = "idle";
	frameIndex = 0;
	playing = false;
	timer;
	resumeState;
	disposed = false;
	constructor(options = {}) {
		this.clock = options.clock ?? realClock;
		this.onFrame = options.onFrame;
	}
	get currentState() {
		return this.state;
	}
	/** Switch the looping animation. Restarts from the first frame. */
	setState(state) {
		if (this.state === state && this.playing) return;
		this.state = state;
		this.frameIndex = 0;
		this.resumeState = void 0;
		this.scheduleNext();
	}
	/** Play a transient state once, then return to `resume` (used for idle variations). */
	playTransient(state, resume) {
		this.state = state;
		this.frameIndex = 0;
		this.resumeState = resume;
		this.scheduleNext();
	}
	start() {
		if (this.playing || this.disposed) return;
		this.playing = true;
		this.frameIndex = 0;
		this.scheduleNext();
	}
	stop() {
		this.playing = false;
		if (this.timer !== void 0) {
			this.clock.clearTimeout(this.timer);
			this.timer = void 0;
		}
	}
	emitCurrent() {
		try {
			this.onFrame?.(frameDirective(this.state, this.frameIndex));
		} catch (error) {
			if (typeof console !== "undefined") console.warn("[desktop-pet] frame error:", error?.message);
		}
	}
	scheduleNext() {
		if (!this.playing || this.disposed) return;
		if (this.timer !== void 0) this.clock.clearTimeout(this.timer);
		const row = animationRowFor(this.state);
		if (!row) return;
		const durations = row.durations;
		const duration = durations[this.frameIndex % durations.length] ?? 150;
		this.emitCurrent();
		const frameCount = durations.length;
		this.timer = this.clock.setTimeout(() => {
			this.timer = void 0;
			if (!this.playing || this.disposed) return;
			this.frameIndex = (this.frameIndex + 1) % frameCount;
			if (this.resumeState !== void 0 && this.frameIndex === 0) {
				this.state = this.resumeState;
				this.resumeState = void 0;
			}
			this.scheduleNext();
		}, duration);
	}
	dispose() {
		this.disposed = true;
		this.stop();
	}
};
//#endregion
//#region src/renderer/PetWindow.ts
const BASE_WIDTH = 192;
const BASE_HEIGHT = 208;
/** Native cell size for an animation-mode pet (falls back to the Codex cell). */
function cellSizeOf(pet) {
	const cell = pet?.cell;
	if (cell && Number.isFinite(cell.width) && Number.isFinite(cell.height) && cell.width > 0 && cell.height > 0) return cell;
	return {
		width: BASE_WIDTH,
		height: BASE_HEIGHT
	};
}
const DEFAULT_POSITION = {
	x: 40,
	y: 40
};
const IDLE_TRANSIENTS = ["waving"];
/** Window size for a scale, matching the frontend's `layoutForScale`. */
function windowSizeForScale(scale, cell) {
	const base = cell ?? {
		width: BASE_WIDTH,
		height: BASE_HEIGHT
	};
	const petW = Math.max(1, Math.round(base.width * scale));
	const petH = Math.max(1, Math.round(base.height * scale));
	return {
		width: petW,
		height: Math.max(petH + 1, Math.round(petH / .75))
	};
}
var PetWindow = class {
	backend;
	animationEnabled;
	idleFrequencySec;
	clickThrough;
	clock;
	random;
	onDrag;
	onDragMove;
	onDragEnd;
	onHover;
	onUnhover;
	onClose;
	resolveWebuiUrl;
	onChat;
	onMode;
	onNewSession;
	onQuit;
	onOpenSession;
	pet;
	scale;
	currentX;
	currentY;
	handle;
	controller;
	idleTimer;
	semantic = "IDLE";
	visible = true;
	opened = false;
	destroyed = false;
	hovered = false;
	dragging = false;
	constructor(options) {
		this.backend = options.backend;
		this.pet = options.pet;
		this.scale = options.scale;
		this.animationEnabled = options.animationEnabled;
		this.idleFrequencySec = options.idleFrequencySec;
		this.clickThrough = options.clickThrough ?? false;
		this.alwaysOnTop = options.alwaysOnTop !== false;
		this.clock = options.clock ?? {
			now: () => Date.now(),
			setTimeout: (fn, ms) => setTimeout(fn, ms),
			clearTimeout: (h) => clearTimeout(h)
		};
		this.random = options.random ?? Math.random;
		this.onDrag = options.onDrag;
		this.onDragMove = options.onDragMove;
		this.onDragEnd = options.onDragEnd;
		this.onHover = options.onHover;
		this.onUnhover = options.onUnhover;
		this.onClose = options.onClose;
		this.resolveWebuiUrl = options.resolveWebuiUrl;
		this.onChat = options.onChat;
		this.onReadImage = options.onReadImage;
		this.onMode = options.onMode;
		this.onNewSession = options.onNewSession;
		this.onQuit = options.onQuit;
		this.onOpenSession = options.onOpenSession;
		const position = options.position ?? DEFAULT_POSITION;
		this.currentX = position.x;
		this.currentY = position.y;
	}
	/** Create the overlay window and start the animation loop. */
	async open() {
		if (this.destroyed || this.opened) return;
		this.opened = true;
		const { width, height } = windowSizeForScale(this.scale, cellSizeOf(this.pet));
		const opts = {
			width,
			height,
			x: this.currentX,
			y: this.currentY,
			alwaysOnTop: this.alwaysOnTop,
			petId: this.pet.petId,
			spritesheetPath: this.pet.spritesheetPath,
			animations: this.pet.animations,
			cell: cellSizeOf(this.pet),
			petRoot: this.pet.root,
			scale: this.scale,
			clickThrough: this.clickThrough,
			onDrag: (x, y) => {
				this.currentX = x;
				this.currentY = y;
				this.onDrag?.(x, y);
			},
			onDragMove: (direction) => {
				this.beginDrag(direction);
			},
			onDragEnd: () => {
				this.endDrag();
			},
			onHover: () => {
				this.onHover?.();
			},
			onUnhover: () => {
				this.onUnhover?.();
			},
			onClose: () => {
				this.onClose?.();
			},
			resolveWebuiUrl: () => this.resolveWebuiUrl?.(),
			onChat: (payload) => {
			  this.onChat?.(payload);
			},
			onReadImage: (payload) => {
			  this.onReadImage?.(payload);
			},
			onMode: (payload) => this.onMode?.(payload),
			onNewSession: () => this.onNewSession?.(),
			onQuit: () => this.onQuit?.(),
			onOpenSession: (payload) => this.onOpenSession?.(payload),
		};
		this.handle = await this.backend.create(opts);
		this.controller = new AnimationController({
			clock: this.clock,
			onFrame: (directive) => this.present(directive)
		});
		if (this.animationEnabled) this.controller.start();
		this.applyState(this.semantic);
		if (!this.visible) this.handle.hide();
	}
	/** The current renderer pose (for diagnostics/tests). */
	get currentPose() {
		return this.controller?.currentState;
	}
	/** Set the semantic state; the pose is derived, not caller-decided. */
	setState(state) {
		this.semantic = state;
		if (!this.controller || this.destroyed) return;
		if (this.dragging) return;
		this.applyState(state);
	}
	/** Enter the drag animation, playing the direction pose. */
	beginDrag(direction) {
		if (this.destroyed || !this.controller) return;
		this.dragging = true;
		this.cancelIdleVariation();
		this.controller.setState(direction === "left" ? "running-left" : "running-right");
	}
	/** Exit the drag animation and return to the current semantic pose. */
	endDrag() {
		if (this.destroyed || !this.controller) return;
		this.dragging = false;
		this.applyState(this.semantic);
	}
	/** Show or hide the pet without disposing it. */
	setVisible(visible) {
		this.visible = visible;
		if (this.destroyed || !this.handle) return;
		if (visible) this.handle.show();
		else this.handle.hide();
	}
	/** Update the window topmost flag without rebuilding it. */
	setAlwaysOnTop(enabled) {
		this.alwaysOnTop = Boolean(enabled);
		if (this.destroyed || !this.handle) return;
		try {
			this.handle.setAlwaysOnTop(this.alwaysOnTop);
		} catch {}
	}
	/** Resize the pet by rebuilding the window to the new scale. */
	async setScale(scale) {
		if (this.destroyed || scale === this.scale) return;
		this.scale = scale;
		await this.recreate();
	}
	/** Swap the displayed pet by rebuilding the window. */
	async loadPet(pet) {
		if (this.destroyed || pet.petId === this.pet.petId && pet.spritesheetPath === this.pet.spritesheetPath) return;
		this.pet = pet;
		await this.recreate();
	}
	async recreate() {
		if (!this.opened || this.destroyed) return;
		this.teardownWindow();
		this.opened = false;
		await this.open();
	}
	applyState(state) {
		const pose = SEMANTIC_TO_CODEX[state] ?? "idle";
		this.controller?.setState(pose);
		if (this.pet?.animations) this.handle?.anim?.({ phase: SEMANTIC_TO_ANIM[state] ?? "idle" });
		if (pose === "idle") this.scheduleIdleVariation();
		else this.cancelIdleVariation();
	}
	/** Play the hover reaction (`jumping`) once, then return to the current state. */
	playJump() {
		if (this.destroyed || !this.controller) return;
		if (this.hovered) return;
		this.hovered = true;
		this.controller.playTransient("jumping", SEMANTIC_TO_CODEX[this.semantic] ?? "idle");
	}
	/** End the hover reaction and return to the current semantic pose. */
	endHover() {
		if (this.destroyed || !this.controller) return;
		this.hovered = false;
		this.controller.setState(SEMANTIC_TO_CODEX[this.semantic] ?? "idle");
	}
	scheduleIdleVariation() {
		this.cancelIdleVariation();
		const ms = Math.max(8, this.idleFrequencySec) * 1e3 * (.7 + this.random() * .6);
		this.idleTimer = this.clock.setTimeout(() => {
			this.idleTimer = void 0;
			if (this.destroyed || !this.controller) return;
			const transient = IDLE_TRANSIENTS[Math.floor(this.random() * IDLE_TRANSIENTS.length)];
			this.controller.playTransient(transient, "idle");
			this.idleTimer = this.clock.setTimeout(() => {
				this.idleTimer = void 0;
				if (this.semantic === "IDLE") this.scheduleIdleVariation();
			}, 1500);
		}, ms);
	}
	cancelIdleVariation() {
		if (this.idleTimer !== void 0) {
			this.clock.clearTimeout(this.idleTimer);
			this.idleTimer = void 0;
		}
	}
	present(directive) {
		if (this.destroyed || !this.handle) return;
		try {
			this.handle.present(directive);
		} catch {}
	}
	chatDelta(payload) {
	  if (this.destroyed || !this.handle) return;
	  try {
	    this.handle.chatDelta?.(payload);
	  } catch {}
	}
	chatDone(payload) {
	  if (this.destroyed || !this.handle) return;
	  try {
	    this.handle.chatDone?.(payload);
	  } catch {}
	}
	chatError(payload) {
	  if (this.destroyed || !this.handle) return;
	  try {
	    this.handle.chatError?.(payload);
	  } catch {}
	}
	emit(event, payload) {
		if (this.destroyed || !this.handle) return;
		try {
			this.handle.emit?.(event, payload);
		} catch {}
	}
	openUrl(url) {
		if (this.destroyed || !this.handle) return;
		try {
			this.handle.openUrl?.(url);
		} catch {}
	}
	status(payload) {
		this.emit("pet.status", payload);
	}
	show() {
		this.setVisible(true);
	}
	hide() {
		this.setVisible(false);
	}
	teardownWindow() {
		this.cancelIdleVariation();
		this.controller?.dispose();
		this.controller = void 0;
		try {
			this.handle?.destroy();
		} catch {}
		this.handle = void 0;
	}
	async destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.teardownWindow();
	}
};
//#endregion
//#region src/renderer/backend/NeutralinoBackend.ts
/**
* Neutralinojs window backend.
*
* Replaces the koffi-based Win32/X11 backends with a system-webview overlay:
* the host spawns the Neutralino runtime binary, connects to it over the
* official extension WebSocket protocol, and drives a small frontend that
* slices the pet's sprite sheet on a transparent canvas.
*
* Platform coverage comes from Neutralino itself (WebView2 on Windows,
* WebKitGTK on Linux, WKWebView on macOS); this backend contains no
* platform-specific code beyond picking the right runtime binary.
*
* Static-resource model: the runtime serves files from its `--path` working
* directory only. The tiny frontend bundle is copied there per launch, and the
* pet sprite sheets (in `assets/pets/`) are exposed via a runtime
* `server.mount` of `/pets` so no pet assets are duplicated.
*/
/** Frontend files copied into the per-launch working directory. */
const FRONTEND_DIR = join(NEUTRALINO_APP_DIR, "resources");
/** Runtime binary names per platform/arch (Neutralino v6 release assets). */
const BINARY_NAMES = {
	"win32-x64": "neutralino-win_x64.exe",
	"linux-x64": "neutralino-linux_x64",
	"linux-arm64": "neutralino-linux_arm64",
	"linux-arm": "neutralino-linux_armhf",
	"darwin-x64": "neutralino-mac_x64",
	"darwin-arm64": "neutralino-mac_arm64"
};
/** How long to wait for the runtime to write `.tmp/auth_info.json`. */
const AUTH_TIMEOUT_MS = 15e3;
/** How long to wait for the frontend to report its sprite atlas loaded. */
const UI_READY_TIMEOUT_MS = 15e3;
/** Locate the Neutralino runtime binary for this platform, or `undefined`. */
function resolveRuntimeBinary() {
	const name = BINARY_NAMES[`${process.platform}-${process.arch}`];
	if (!name) return void 0;
	if (process.env.DSH_PET_NEUTRALINO_BIN && existsSync(process.env.DSH_PET_NEUTRALINO_BIN)) return process.env.DSH_PET_NEUTRALINO_BIN;
	const packaged = join(RUNTIME_DIR, name);
	return existsSync(packaged) ? packaged : void 0;
}
/** A tiny JSON-RPC-style helper over the Neutralino extension WebSocket. */
var NeutralinoConnection = class {
	ws;
	pending = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Map();
	auth;
	closed = false;
	connect(auth) {
		this.auth = auth;
		return new Promise((resolve, reject) => {
			const url = `ws://127.0.0.1:${auth.nlPort}?extensionId=petHost&connectToken=${auth.nlConnectToken}`;
			const ws = new WebSocket(url);
			this.ws = ws;
			const failTimer = setTimeout(() => reject(/* @__PURE__ */ new Error("neutralino websocket connect timeout")), 8e3);
			ws.addEventListener("open", () => {
				clearTimeout(failTimer);
				resolve();
			});
			ws.addEventListener("error", () => {
				clearTimeout(failTimer);
				reject(/* @__PURE__ */ new Error("neutralino websocket connection failed"));
			});
			ws.addEventListener("close", () => {
				this.closed = true;
				for (const { reject: rej } of this.pending.values()) rej(/* @__PURE__ */ new Error("neutralino connection closed"));
				this.pending.clear();
			});
			ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
		});
	}
	onMessage(raw) {
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (msg.id && this.pending.has(msg.id)) {
			const { resolve, reject } = this.pending.get(msg.id);
			this.pending.delete(msg.id);
			const data = msg.data;
			if (data?.error) reject(new Error(JSON.stringify(data.error)));
			else resolve(data?.returnValue ?? data);
			return;
		}
		if (msg.event) {
			const set = this.listeners.get(msg.event);
			if (set) for (const listener of set) listener(msg.data);
		}
	}
	/** Invoke a Neutralino native API method (e.g. `window.move`). */
	call(method, data) {
		if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(/* @__PURE__ */ new Error("neutralino connection not open"));
		return new Promise((resolve, reject) => {
			const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const timer = setTimeout(() => {
				if (this.pending.delete(id)) reject(/* @__PURE__ */ new Error(`neutralino call timeout: ${method}`));
			}, 5e3);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				}
			});
			this.ws.send(JSON.stringify({
				id,
				method,
				data,
				accessToken: this.auth.nlToken
			}));
		});
	}
	/** Push an event to the window (frontend `Neutralino.events.on`). */
	broadcast(event, data) {
		this.call("app.broadcast", {
			event,
			data
		}).catch(() => {});
	}
	on(event, listener) {
		let set = this.listeners.get(event);
		if (!set) {
			set = /* @__PURE__ */ new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
		};
	}
	close() {
		this.closed = true;
		try {
			this.ws?.close();
		} catch {}
		this.ws = void 0;
		this.listeners.clear();
	}
};
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Read `.tmp/auth_info.json`, retrying while the runtime is starting up. */
async function waitForAuthInfo(workDir) {
	const authPath = join(workDir, ".tmp", "auth_info.json");
	const deadline = Date.now() + AUTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (existsSync(authPath)) try {
			const parsed = JSON.parse(readFileSync(authPath, "utf8"));
			if (parsed.nlPort !== void 0 && parsed.nlToken && parsed.nlConnectToken) return parsed;
		} catch {}
		await delay(150);
	}
	throw new Error("neutralino runtime did not export auth info in time");
}
function withTimeout(promise, ms, message) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then((v) => {
			clearTimeout(timer);
			resolve(v);
		}, (e) => {
			clearTimeout(timer);
			reject(e);
		});
	});
}
var NeutralinoBackend = class {
	name = "neutralino";
	isSupported() {
		return resolveRuntimeBinary() !== void 0;
	}
	async create(options) {
		const binary = resolveRuntimeBinary();
		if (!binary) throw new Error("neutralino runtime binary not found (run `npm run postinstall`)");
		const workDir = join(tmpdir(), `dsh-desktop-pet-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(workDir, { recursive: true });
		const serveRoot = join(workDir, "resources");
		mkdirSync(serveRoot, { recursive: true });
		for (const name of readdirSync(FRONTEND_DIR)) copyFileSync(join(FRONTEND_DIR, name), join(serveRoot, name));
		const config = JSON.parse(readFileSync(join(NEUTRALINO_APP_DIR, "neutralino.config.json"), "utf8"));
		config.modes.window.width = options.width;
		config.modes.window.height = options.height;
		config.modes.window.x = options.x;
		config.modes.window.y = options.y;
		config.modes.window.alwaysOnTop = options.alwaysOnTop;
		writeFileSync(join(workDir, "neutralino.config.json"), JSON.stringify(config, null, 2));
		const child = spawn(binary, [`--path=${workDir}`, "--res-mode=directory"], {
			cwd: workDir,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let childExited = false;
		child.on("exit", () => {
			childExited = true;
		});
		child.stdout?.on("data", () => {});
		child.stderr?.on("data", () => {});
		const killChild = () => {
			if (childExited || child.pid === void 0) return;
			if (process.platform === "win32") {
				try {
					execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore" });
				} catch {}
				return;
			}
			try {
				child.kill();
			} catch {}
		};
		let conn;
		try {
			const auth = await waitForAuthInfo(workDir);
			conn = new NeutralinoConnection();
			await conn.connect(auth);
		} catch (error) {
			killChild();
			rmSync(workDir, {
				recursive: true,
				force: true
			});
			throw error;
		}
		try {
			mkdirSync(USER_PETS_DIR, { recursive: true });
		} catch {}
		try {
			await conn.call("server.mount", {
				path: "/pets",
				target: PETS_DIR
			});
		} catch (error) {
			killChild();
			conn.close();
			rmSync(workDir, {
				recursive: true,
				force: true
			});
			throw new Error(`failed to mount pet directory: ${error?.message ?? String(error)}`);
		}
		try {
			await conn.call("server.mount", {
				path: "/user-pets",
				target: USER_PETS_DIR
			});
		} catch (error) {
			console.warn("[desktop-pet] failed to mount user pets directory: %s", error?.message ?? String(error));
		}
		const offHover = conn.on("pet.hover", () => options.onHover?.());
		const offUnhover = conn.on("pet.unhover", () => options.onUnhover?.());
		const offDragMove = conn.on("pet.dragMove", (data) => {
			const direction = data?.direction;
			if (direction === "left" || direction === "right") options.onDragMove?.(direction);
		});
		const offDragEnd = conn.on("pet.dragEnd", () => options.onDragEnd?.());
		const offDrag = conn.on("pet.drag", (data) => {
			const pos = data;
			if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) options.onDrag?.(pos.x, pos.y);
		});
		const offChat = conn.on("pet.chat", (data) => options.onChat?.(data));
		const offReadImage = conn.on("pet.readImage", (data) => options.onReadImage?.(data));
		const offSaveScale = conn.on("pet.saveScale", (data) => {
			const scale = typeof data?.scale === "number" ? data.scale : void 0;
			if (scale === void 0) return;
			saveUiState({ scale });
		});
		const offMode = conn.on("pet.mode", (data) => options.onMode?.(data));
		const offNewSession = conn.on("pet.newSession", () => options.onNewSession?.());
		const offQuit = conn.on("pet.quit", (data) => options.onQuit?.(data));
		const offOpenSession = conn.on("pet.openSession", (data) => options.onOpenSession?.(data));
		const offClose = conn.on("pet.close", () => options.onClose?.());
		const offOpenWebui = conn.on("pet.openWebui", () => {
			const url = options.resolveWebuiUrl?.();
			if (!url) return;
			conn.call("os.open", { url }).catch(() => {});
		});
		const frontendReady = new Promise((resolve) => {
			const off = conn.on("pet.frontendReady", () => {
				off();
				resolve();
			});
		});
		conn.broadcast("pet.handshakeQuery", {});
		await withTimeout(frontendReady, UI_READY_TIMEOUT_MS, "frontend did not become ready");
		const assetRoot = options.petRoot === "user" ? "/user-pets" : "/pets";
		const animBase = options.animations && Object.keys(options.animations).length > 0 ? `${assetRoot}/${options.petId}/` : void 0;
		const spritesheetUrl = options.spritesheetPath ? `${assetRoot}/${options.petId}/${options.spritesheetPath}` : void 0;
		conn.broadcast("pet.init", {
			scale: options.scale,
			savedScale: loadUiState()?.scale,
			spritesheetUrl,
			animations: options.animations,
			animBase,
			cell: options.cell,
			x: options.x,
			y: options.y
		});
		await withTimeout(new Promise((resolve, reject) => {
			const offReady = conn.on("pet.uiReady", () => {
				offReady();
				offError();
				resolve();
			});
			const offError = conn.on("pet.uiError", (data) => {
				offReady();
				offError();
				reject(new Error(data?.message ?? "pet frontend failed to load"));
			});
		}), UI_READY_TIMEOUT_MS, "pet sprite atlas did not load in time");
		let destroyed = false;
		const handle = {
			present: (directive) => {
				if (destroyed) return;
				conn.broadcast("pet.frame", directive);
			},
			anim: (payload) => {
				if (destroyed) return;
				conn.broadcast("pet.anim", payload);
			},
			chatDelta: (payload) => {
			  if (destroyed) return;
			  conn.broadcast("pet.chat.delta", payload);
			},
			chatDone: (payload) => {
			  if (destroyed) return;
			  conn.broadcast("pet.chat.done", payload);
			},
			chatError: (payload) => {
			  if (destroyed) return;
			  conn.broadcast("pet.chat.error", payload);
			},
			emit: (event, payload) => {
				if (destroyed) return;
				conn.broadcast(event, payload);
			},
			openUrl: (url) => {
				if (destroyed || typeof url !== "string" || url.length === 0) return;
				conn.call("os.open", { url }).catch(() => {});
			},
			move: (x, y) => {
				if (destroyed) return;
				conn.call("window.move", {
					x,
					y
				}).catch(() => {});
			},
			setAlwaysOnTop: (value) => {
				if (destroyed) return;
				conn.call("window.setAlwaysOnTop", { onTop: value }).catch(() => {});
			},
			show: () => {
				if (destroyed) return;
				conn.call("window.show").catch(() => {});
			},
			hide: () => {
				if (destroyed) return;
				conn.call("window.hide").catch(() => {});
			},
			destroy: () => {
				if (destroyed) return;
				destroyed = true;
				offHover();
				offUnhover();
				offDragMove();
				offDragEnd();
				offDrag();
				offClose();
				offOpenWebui();
				offChat();
				offSaveScale();
				offReadImage();
				offMode();
				offNewSession();
				offQuit();
				offOpenSession();
				conn.close();
				killChild();
				rmSync(workDir, {
					recursive: true,
					force: true
				});
			}
		};
		child.on("exit", () => {
			if (!destroyed) {
				if (typeof console !== "undefined") console.warn("[desktop-pet] neutralino runtime exited unexpectedly");
			}
		});
		return handle;
	}
};
//#endregion
//#region src/renderer/backend/selectBackend.ts
/**
* Backend selection. The renderer asks for a backend without knowing the OS;
* this module returns the Neutralino backend when its runtime binary is
* present, otherwise `undefined` so the plugin can degrade gracefully
* (no window, still loaded).
*/
const BACKENDS = [new NeutralinoBackend()];
function selectBackend() {
	return BACKENDS.find((backend) => {
		try {
			return backend.isSupported();
		} catch {
			return false;
		}
	});
}
//#endregion
//#region src/index.ts
const name = "desktop-pet";
/** Media type of a chat image path, judged by extension. */
function chatImageMediaType(filePath) {
	const lower = String(filePath).toLowerCase();
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".bmp")) return "image/bmp";
	return "image/png";
}
/** Caps for images one chat turn may carry. */
const CHAT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const CHAT_MAX_IMAGES = 4;
/** Read one local image into a data URL for the chat UI. */
function chatImageDataUrl(filePath) {
	const info = statSync(filePath);
	if (!info.isFile()) throw new Error("不是图片文件");
	if (info.size > CHAT_IMAGE_MAX_BYTES) throw new Error("图片超过 8MB");
	return "data:" + chatImageMediaType(filePath) + ";base64," + readFileSync(filePath).toString("base64");
}
/** Prompt image blocks for the picked paths, skipping unreadable files. */
function chatImageBlocks(paths) {
	const blocks = [];
	for (const filePath of paths) {
		try {
			const info = statSync(filePath);
			if (!info.isFile() || info.size > CHAT_IMAGE_MAX_BYTES) continue;
			blocks.push({ type: "image", mediaType: chatImageMediaType(filePath), data: readFileSync(filePath).toString("base64"), name: basename(filePath) });
		} catch {}
	}
	return blocks;
}
const inject = [];
function apply(ctx, config) {
	const petCtx = ctx;
	const log = petCtx.logger("desktop-pet");
	if (!config.enabled) {
		log.info("disabled by config; not starting");
		return;
	}
	petCtx.effect(() => {
		let disposed = false;
		let bridge;
		let window;
		let manuallyClosed = false;
		let machine;
		let unsubscribe;
		let unregisterCommand;
		let debugState;
		let stopFullscreenWatch;
		let fullscreenForeground = false;
		function applyTopmost() {
			window?.setAlwaysOnTop?.(Boolean(config.alwaysOnTop) && !fullscreenForeground);
			applyVisibility(machine?.state);
		}
		let settingsHandle;
		let currentSettings = {
			enabled: config.enabled,
			petScale: config.petScale,
			petId: config.petId,
			hideWhenIdle: config.hideWhenIdle,
			availablePets: []
		};
		let catalog = [];
		let loadedPetKey = null;
		let reconcileSeq = 0;
		let importSeq = 0;
		const handledImportRequests = /* @__PURE__ */ new Set();
		let activeImportRequest = null;
		let directoryPicker;
		let llmRuntime;
		let defaultModelConfig;
		let chatAbort;
		let chatBusy = false;
		const chatTranscript = [];
		const CHAT_MAX_TURNS = 8;
		const CHAT_MAX_INPUT = 2000;
		const CHAT_SYSTEM = "你是蕾米埃尔（小蕾米），住在用户 Windows 桌面上的像素画师桌宠。用中文、口语化地回答，通常 1-3 句；语气软萌亲切、偶尔小得意；不要用 Markdown、列表或代码块；用户问技术问题时简明作答，不确定就直说。";
		const savedChat = loadChatState();
		let chatMode = "agent";
		let agentSessionId = savedChat?.sessionId;
		const chatTurns = Array.isArray(savedChat?.turns) ? savedChat.turns.slice() : [];
		let chatPersistTimer;
		let agentBusy = false;
		let agentBuffer = "";
		let agentPending = false;
		let gatewayRuntime;
		let workspacesRuntime;
		let commandsRuntime;
		let agentPeer;
		function persistChatSoon() {
			if (chatPersistTimer !== void 0) clearTimeout(chatPersistTimer);
			chatPersistTimer = setTimeout(() => {
				chatPersistTimer = void 0;
				saveChatState({ mode: chatMode, sessionId: agentSessionId, turns: chatTurns.slice(-60) });
			}, 350);
			if (chatPersistTimer.unref) chatPersistTimer.unref();
		}
		function recordTurn(role, text, images) {
			if (typeof text !== "string" || text.length === 0) return;
			const turn = { role, text, at: Date.now() };
			if (Array.isArray(images) && images.length > 0) turn.images = images.slice(0, CHAT_MAX_IMAGES);
			chatTurns.push(turn);
			while (chatTurns.length > 60) chatTurns.shift();
			persistChatSoon();
		}
		function gatewayPeer() {
			if (agentPeer !== void 0) return agentPeer;
			const controller = new AbortController();
			agentPeer = {
				id: "pet-remielle:" + crypto.randomUUID(),
				ctx: petCtx,
				principal: { kind: "owner" },
				signal: controller.signal,
				interactions: "none",
				dispose() { try { controller.abort(); } catch {} }
			};
			petCtx.effect(() => () => { void agentPeer?.dispose?.(); }, "pet-remielle owner peer");
			return agentPeer;
		}
		function gatewayInvoke(namespace, method, request, signal) {
			if (gatewayRuntime === void 0) throw new Error("桌面助手还没准备好，稍等一下再试");
			return gatewayRuntime.invoke({ namespace, method, args: { request }, peer: gatewayPeer(), ...(signal === void 0 ? {} : { signal }) });
		}
		function pickWorkspace() {
			let list = [];
			try { list = workspacesRuntime?.list?.() ?? []; } catch { list = []; }
			if (!Array.isArray(list) || list.length === 0) return void 0;
			const stamp = (item) => {
				const value = item?.lastOpenedAt ?? item?.lastUsedAt ?? item?.updatedAt ?? item?.createdAt;
				return typeof value === "number" ? value : 0;
			};
			return list.slice().sort((a, b) => stamp(b) - stamp(a))[0];
		}
		function workspaceLabel(ws) {
			if (typeof ws?.title === "string" && ws.title.length > 0) return ws.title;
			if (typeof ws?.path === "string" && ws.path.length > 0) return ws.path;
			return "工作区";
		}
		async function ensureAgentSession() {
			if (typeof agentSessionId === "string" && agentSessionId.length > 0) return agentSessionId;
			const ws = pickWorkspace();
			if (ws === void 0) throw new Error("还没有打开过工作区，先在 DSH 里打开一个项目吧");
			const created = await gatewayInvoke("session", "create", { workspaceId: ws.id });
			const sessionId = created?.sessionId;
			if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("创建会话失败了");
			agentSessionId = sessionId;
			persistChatSoon();
			try { await gatewayInvoke("session", "rename", { sessionId, title: "蕾米埃尔 · 桌面助手" }); } catch {}
			if (commandsRuntime !== void 0) {
				try {
					const command = await commandsRuntime.execute(sessionId, "/permission workspace-write", AbortSignal.timeout(3e4));
					if (command !== void 0 && command.kind !== "success") log.warn("permission command failed: %s", command.text ?? command.kind);
				} catch (error) { log.warn("permission command threw: %s", error?.message ?? String(error)); }
			}
			const selection = chatSelection();
			if (selection !== void 0) {
				try {
					await gatewayInvoke("session", "selectModel", { sessionId, provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }) });
				} catch (error) { log.warn("model selection failed: %s", error?.message ?? String(error)); }
			}
			if (!disposed) window?.emit("pet.session", { sessionId, workspace: workspaceLabel(ws), workspacePath: ws.path });
			return sessionId;
		}
		async function handleAgentChat(text, imagePaths) {
			if (agentBusy) { window?.chatError({ message: "上一件事还没做完呢，等我一下下～" }); return; }
			agentBusy = true;
			agentPending = true;
			agentBuffer = "";
			window?.setState("THINKING");
			try {
				const isFirst = !(typeof agentSessionId === "string" && agentSessionId.length > 0);
				const sessionId = await ensureAgentSession();
				void isFirst;
				const content = [{ type: "text", text }, ...chatImageBlocks(imagePaths ?? [])];
				await gatewayInvoke("session", "prompt", { sessionId, requestId: "pet-remielle-" + crypto.randomUUID(), mode: "queue", content });
				if (!disposed) window?.setState("WORKING");
			} catch (error) {
				agentBusy = false;
				agentPending = false;
				if (!disposed) {
					window?.chatError({ message: "活儿没派出去：" + (error?.message ?? String(error)) });
					window?.setState(machine?.state ?? "IDLE");
				}
			}
		}
		function finishAgentTurn(errorMessage) {
			if (!agentPending) return;
			agentPending = false;
			agentBusy = false;
			const answer = agentBuffer.trim();
			agentBuffer = "";
			if (disposed) return;
			if (typeof errorMessage === "string" && errorMessage.length > 0) window?.chatError({ message: errorMessage });
			else {
				window?.chatDone({ text: answer });
				recordTurn("assistant", answer);
			}
			window?.setState(machine?.state ?? "IDLE");
		}
		function onAgentStream(payload) {
			if (typeof agentSessionId !== "string" || agentSessionId.length === 0) return;
			const agentId = payload?.agent?.id ?? payload?.agent?.sessionId ?? payload?.agent;
			if (agentId !== agentSessionId) return;
			const frame = payload?.frame;
			if (frame === void 0) return;
			if (frame.type === "start") { agentBuffer = ""; agentPending = true; window?.setState("WRITING"); return; }
			if (frame.type === "chunk") {
				const chunk = frame.chunk;
				if (chunk?.type !== "text-delta" || typeof chunk.text !== "string" || chunk.text.length === 0) return;
				agentBuffer += chunk.text;
				if (!disposed) window?.chatDelta({ text: chunk.text });
				return;
			}
			if (frame.type === "end") finishAgentTurn();
		}
		function onAgentStatus(payload) {
			if (!agentPending) return;
			const id = payload?.agent?.id ?? payload?.agent?.sessionId ?? payload?.agent;
			if (id !== agentSessionId) return;
			if (payload?.status !== "idle") return;
			setTimeout(() => { if (agentPending) finishAgentTurn(); }, 500);
		}
		function onAgentSessionEvent(session, event) {
			if (typeof agentSessionId !== "string" || agentSessionId.length === 0) return;
			const id = session?.id ?? session?.sessionId ?? session;
			if (id !== agentSessionId) return;
			const type = event?.type;
			if (type === "tool/call" || type === "command/run") {
				const name = event?.data?.name ?? (type === "command/run" ? "终端" : "工具");
				if (!disposed) window?.status({ text: "正在用 " + String(name) + " …" });
			}
		}
		async function handleModeSwitch(payload) {
			window?.emit("pet.mode", { mode: chatMode, sessionId: agentSessionId });
		}
		function handleNewSession() {
			agentSessionId = void 0;
			agentBusy = false;
			agentPending = false;
			agentBuffer = "";
			persistChatSoon();
			window?.emit("pet.session", { sessionId: null });
			window?.emit("pet.mode", { mode: chatMode, sessionId: null });
		}
		function handleOpenSession(payload) {
			const target = typeof payload?.sessionId === "string" && payload.sessionId.length > 0 ? payload.sessionId : agentSessionId;
			if (typeof target !== "string" || target.length === 0) return;
			const base = typeof webuiUrl === "string" && webuiUrl.length > 0 ? webuiUrl : "http://127.0.0.1";
			window?.openUrl(base.replace(/\/$/, "") + "/#/session/" + encodeURIComponent(target));
		}
		async function reopenPet() {
			manuallyClosed = false;
			if (!currentSettings.enabled) {
				currentSettings.enabled = true;
				try { settingsHandle?.update({ enabled: true }); } catch {}
			}
			await reconcile(currentSettings).catch(() => {});
		}
		function handleQuit() {
			// 完全关闭：记下本地下线标记再销毁窗口，窗口不会再被 reconcile 重建；
			// 重新打开用 /pet on，或在插件面板里关掉再启用本插件。
			manuallyClosed = true;
			const target = window;
			window = void 0;
			try { target?.destroy(); } catch {}
		}
		/** Answer a window request for one local image, as a data URL. */
		function serveChatImage(payload) {
			const id = typeof payload?.id === "string" ? payload.id : "";
			const filePath = typeof payload?.path === "string" ? payload.path.trim() : "";
			if (filePath.length === 0) { window?.emit("pet.imageData", { id, error: "没有路径" }); return; }
			try {
				window?.emit("pet.imageData", { id, path: filePath, dataUrl: chatImageDataUrl(filePath) });
			} catch (error) {
				window?.emit("pet.imageData", { id, path: filePath, error: error?.message ?? String(error) });
			}
		}
		async function handleChat(data) {
			if (disposed || !window) return;
			const payload = data && typeof data === "object" ? data : {};
			if (payload.type === "cancel") {
				agentPending = false;
				agentBusy = false;
				chatAbort?.abort();
				return;
			}
			if (typeof payload.text !== "string" || payload.text.trim().length === 0) return;
			const text = payload.text.trim();
			const imagePaths = Array.isArray(payload.imagePaths)
				? payload.imagePaths.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()).slice(0, CHAT_MAX_IMAGES)
				: [];
			recordTurn("user", text, imagePaths);
			if (gatewayRuntime === void 0) { await handleChatLlm({ text, mode: "chat" }); return; }
			await handleAgentChat(text, imagePaths);
		}
		let webuiUrl;
		let selfHealChecked = false;
		/** Whether the window should be visible given the current state + settings. */
		function shouldBeVisibleFor(state) {
			return shouldBeVisible(state, currentSettings.enabled, currentSettings.hideWhenIdle, debugState);
		}
		function applyVisibility(state) {
			window?.setVisible(shouldBeVisibleFor(state) && !fullscreenForeground);
		}
		/**
		* Resolve the pet id to actually load. A persisted petId may reference a
		* directory that has since been removed; fall back to the first available
		* catalog entry instead of failing the whole renderer.
		*/
		function effectivePetId(petId) {
			if (catalog.some((entry) => entry.id === petId)) return petId;
			return catalog[0]?.id ?? "text";
		}
		/** Apply a resolved settings snapshot to the window (idempotent). */
		async function reconcile(settings) {
			const seq = ++reconcileSeq;
			const petId = effectivePetId(settings.petId);
			const petKey = petId;
			if (manuallyClosed || !settings.enabled) {
				if (window) {
					const target = window;
					window = void 0;
					try { await target.destroy(); } catch {}
				}
				return;
			}
			if (window) {
				applyVisibility(machine?.state);
				await window.setScale(settings.petScale);
				applyTopmost();
				if (petKey !== loadedPetKey) {
					loadedPetKey = petKey;
					try {
						const pet = await resolvePetManifest(petId);
						if (disposed || seq !== reconcileSeq) return;
						await window.loadPet(pet);
					} catch (error) {
						log.warn("failed to switch pet; keeping current: %s", error?.message ?? String(error));
					}
				}
				return;
			}
			loadedPetKey = petKey;
			let pet;
			try {
				pet = await resolvePetManifest(petId);
			} catch (error) {
				log.warn("failed to load pet assets; renderer disabled: %s", error?.message ?? String(error));
				return;
			}
			if (disposed || seq !== reconcileSeq) return;
			const backend = selectBackend();
			if (!backend) {
				log.warn("no supported window backend on %s; renderer disabled", process.platform);
				return;
			}
			try {
				window = new PetWindow({
					backend,
					pet,
					scale: settings.petScale,
					alwaysOnTop: config.alwaysOnTop,
					animationEnabled: config.animationEnabled,
					idleFrequencySec: config.idleFrequencySec,
					clickThrough: config.clickThrough,
					position: loadPosition(),
					onDrag: (x, y) => savePosition({
						x,
						y
					}),
					onHover: () => {
						window?.playJump();
					},
					onUnhover: () => {
						window?.endHover();
					},
					onClose: () => {
						if (settingsHandle) settingsHandle.update({ enabled: false });
						else {
							currentSettings.enabled = false;
							applyVisibility(machine?.state);
						}
					},
					onChat: (payload) => {
					  void handleChat(payload);
					},
					onReadImage: (payload) => {
					  serveChatImage(payload);
					},
					onMode: (payload) => {
					  void handleModeSwitch(payload);
					},
					onNewSession: () => {
					  handleNewSession();
					},
					onQuit: (payload) => {
					  handleQuit(payload);
					},
					onOpenSession: (payload) => {
					  handleOpenSession(payload);
					},
					resolveWebuiUrl: () => webuiUrl
				});
				await window.open();
				window.emit("pet.history", { mode: chatMode, sessionId: agentSessionId, turns: chatTurns.slice(-40) });
				window.emit("pet.mode", { mode: chatMode, sessionId: agentSessionId });
				if (disposed) {
					await window.destroy();
					window = void 0;
					return;
				}
				const initialState = config.startSleeping ? "SLEEPING" : "IDLE";
				window.setState(initialState);
				applyTopmost();
				applyVisibility(initialState);
				log.info("pet window created via %s backend (%s)", backend.name, petKey);
			} catch (error) {
				log.warn("failed to create pet window; renderer disabled: %s", error?.message ?? String(error));
				window = void 0;
			}
		}
		function chatSelection() {
		  try {
		    const sel = defaultModelConfig?.currentSelection?.();
		    if (sel && typeof sel.provider === "string" && typeof sel.model === "string") return sel;
		  } catch {}
		  return void 0;
		}
		async function openChatStream(selection, request) {
		  const call = {
		    provider: selection.provider,
		    model: selection.model,
		    ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {})
		  };
		  const runtime = llmRuntime;
		  if (runtime && typeof runtime.prepareCall === "function") {
		    const prepared = await runtime.prepareCall(call, request.signal);
		    return prepared.stream({ ...prepared.config, ...request });
		  }
		  return runtime.stream({ ...call, ...request });
		}
		function chatCompose(text) {
		  const parts = [];
		  for (const turn of chatTranscript.slice(-CHAT_MAX_TURNS * 2)) parts.push((turn.role === "user" ? "用户" : "蕾米埃尔") + "：" + turn.text);
		  parts.push("用户：" + text);
		  parts.push("蕾米埃尔：");
		  return parts.join(" / ");
		}
		async function handleChatLlm(data) {
		  if (disposed || !window) return;
		  const payload = data && typeof data === "object" ? data : {};
		  if (payload.type === "cancel") {
		    chatAbort?.abort();
		    return;
		  }
		  if (typeof payload.text !== "string" || payload.text.trim().length === 0) return;
		  const text = payload.text.trim();
		  if (text.length > CHAT_MAX_INPUT) {
		    window.chatError({ message: "这句话太长啦，最多 " + CHAT_MAX_INPUT + " 字～" });
		    return;
		  }
		  if (chatBusy) {
		    window.chatError({ message: "还在想上一句呢，等我一下下～" });
		    return;
		  }
		  const selection = chatSelection();
		  if (!llmRuntime || !selection) {
		    window.chatError({ message: "还没有可用的模型，先在 DSH 里配置一下吧" });
		    return;
		  }
		  chatBusy = true;
		  const controller = typeof AbortController === "function" ? new AbortController() : void 0;
		  chatAbort = controller;
		  window.setState("THINKING");
		  let answer = "";
		  try {
		    const request = {
		      messages: [{ role: "user", content: [{ type: "text", text: chatCompose(text) }] }],
		      system: CHAT_SYSTEM,
		      ...(controller ? { signal: controller.signal } : {})
		    };
		    const stream = await openChatStream(selection, request);
		    let pending = "";
		    let lastFlush = Date.now();
		    for await (const chunk of stream) {
		      if (chunk?.type !== "text-delta" || typeof chunk.text !== "string") continue;
		      answer += chunk.text;
		      pending += chunk.text;
		      if (pending.length >= 24 || Date.now() - lastFlush > 120) {
		        window?.chatDelta({ text: pending });
		        pending = "";
		        lastFlush = Date.now();
		      }
		    }
		    if (pending) window?.chatDelta({ text: pending });
		    answer = answer.trim();
		    window?.chatDone({ text: answer });
		    chatTranscript.push({ role: "user", text }, { role: "assistant", text: answer });
		    recordTurn("assistant", answer);
		    while (chatTranscript.length > CHAT_MAX_TURNS * 2) chatTranscript.shift();
		  } catch (error) {
		    const message = error?.name === "AbortError" ? "唔，那不说这个了～" : "说话失败了：" + (error?.message ?? String(error));
		    window?.chatError({ message });
		  } finally {
		    chatBusy = false;
		    chatAbort = void 0;
		    if (!disposed) window?.setState(machine?.state ?? "IDLE");
		  }
		}
		const debugHost = {
			async setEnabled(enabled) {
				if (enabled) {
					await reopenPet();
					return;
				}
				manuallyClosed = true;
				await reconcile(currentSettings).catch(() => {});
			},
			setDebugState(state) {
				debugState = state;
				window?.setState(state);
				applyVisibility(state);
			},
			resetDebugState() {
				debugState = void 0;
				if (machine) applyVisibility(machine.state);
			}
		};
		bridge = createHarnessBridge(petCtx);
		bridge.start().catch((error) => {
			log.warn("bridge start failed: %s", error?.message ?? String(error));
		});
		petCtx.on("agent/assistant-stream", (payload) => {
			try { onAgentStream(payload); } catch (error) { log.warn("agent stream handler failed: %s", error?.message ?? String(error)); }
		}, { global: true });
		petCtx.on("agent/status", (payload) => {
			try { onAgentStatus(payload); } catch {}
		}, { global: true });
		petCtx.on("session/event", (session, event) => {
			try { onAgentSessionEvent(session, event); } catch {}
		}, { global: true });
		machine = new PetStateMachine({ onChange: (state) => {
			if (disposed) return;
			if (debugState === void 0) window?.setState(state);
			applyVisibility(state);
		} });
		/* PETWATCH begin */
		const PET_BUSY_STATES = /* @__PURE__ */ new Set(["THINKING", "WORKING", "CODING", "RUNNING_COMMAND", "WRITING"]);
		const PET_STALE_TASK_MS = 18e4;
		const PET_QUIET_IDLE_MS = 75e3;
		const petWatch = setInterval(() => {
			if (disposed || !machine) return;
			try {
				const now = Date.now();
				for (const [taskId, task] of Array.from(machine.tasks.entries())) {
					if (task && PET_BUSY_STATES.has(task.state) && now - task.updatedAt > PET_STALE_TASK_MS) machine.removeTask(taskId);
				}
				if (PET_BUSY_STATES.has(machine.state) && now - machine.lastActivityAt > PET_QUIET_IDLE_MS) {
					for (const [taskId, task] of Array.from(machine.tasks.entries())) {
						if (task && PET_BUSY_STATES.has(task.state)) machine.removeTask(taskId);
					}
				}
			} catch (error) {}
		}, 5e3);
		if (petWatch.unref) petWatch.unref();
		/* PETWATCH end */
		unsubscribe = bridge.subscribe((event) => {
			if (disposed) return;
			machine?.onEvent(event);
		});
		unregisterCommand = registerPetCommand({ commands: petCtx.get("commands") }, debugHost);
		catalog = scanPets();
		currentSettings.availablePets = catalog;
		petCtx.inject(["settings"], (sctx) => {
			settingsHandle = installPetSettings(sctx.get("settings"), currentSettings, (settings) => {
				if (disposed) return;
				currentSettings = {
					...settings,
					availablePets: catalog
				};
				if (!selfHealChecked) {
					selfHealChecked = true;
					const targetId = typeof settings.petId === "string" && settings.petId.length > 0 ? settings.petId : void 0;
					if (targetId && !catalog.some((entry) => entry.id === targetId)) {
						const heal = restorePetFromSource(targetId);
						if (heal.restored) {
							log.warn("pet \"%s\" was missing; restored from source", targetId);
							catalog = scanPets();
						} else log.warn("pet \"%s\" is missing and could not be restored (%s)", targetId, heal.reason ?? "unknown");
					}
					log.info("pets on disk: %s", catalog.map((p) => p.id).join(", ") || "(none)");
				}
				if (!sameCatalog(settings.availablePets, catalog)) Promise.resolve(settingsHandle?.update({ availablePets: catalog })).catch((error) => {
					log.warn("catalog write-back failed: %s", error?.message ?? String(error));
				});
				if (settings.petAction) handlePetAction(settings.petAction);
				return reconcile(currentSettings).catch((error) => {
					log.warn("settings reconcile failed: %s", error?.message ?? String(error));
				});
			});
		});
		petCtx.inject(["directoryPicker"], (sctx) => {
			directoryPicker = sctx.get("directoryPicker");
		});
		petCtx.inject(["llm"], (sctx) => {
		  llmRuntime = sctx.get("llm");
		});
		petCtx.inject(["agentDefaultModel"], (sctx) => {
		  defaultModelConfig = sctx.get("agentDefaultModel");
		});
		petCtx.inject(["typertGateway"], (sctx) => {
		  gatewayRuntime = sctx.get("typertGateway");
		});
		petCtx.inject(["workspaceRegistry"], (sctx) => {
		  workspacesRuntime = sctx.get("workspaceRegistry");
		});
		petCtx.inject(["commands"], (sctx) => {
		  commandsRuntime = sctx.get("commands");
		});
		petCtx.inject(["webServer"], (sctx) => {
			webuiUrl = webUiUrl(sctx.get("webServer")?.port);
		});
		/** Execute a one-shot import request from the settings card. */
		async function handlePetAction(action) {
			if (handledImportRequests.has(action.requestId)) return;
			if (activeImportRequest !== null && activeImportRequest !== action.requestId) return;
			handledImportRequests.add(action.requestId);
			activeImportRequest = action.requestId;
			const seq = ++importSeq;
			const requestId = action.requestId;
			const writeResult = async (patch) => {
				if (seq !== importSeq) return;
				try {
					await settingsHandle?.update(patch);
				} catch (error) {
					log.warn("import result write failed: %s (patch keys: %s)", error?.message ?? String(error), Object.keys(patch).join(","));
				}
			};
			const fail = async (code, detail) => {
				await writeResult({
					petAction: null,
					importResult: {
						ok: false,
						code,
						requestId,
						at: Date.now(),
						detail
					}
				});
			};
			try {
				let result;
				if (action.kind === "importFolder") {
					const capability = directoryPicker?.capability();
					if (!capability || capability.kind !== "native" || !capability.pick) {
						await fail("no-folder-picker");
						return;
					}
					let chosen;
					try {
						chosen = await capability.pick(new AbortController().signal);
					} catch (error) {
						await fail("copy-failed", error?.message);
						return;
					}
					if (!chosen) {
						await writeResult({ petAction: null });
						return;
					}
					result = importPetFromDirectory(chosen);
				} else result = await importPetFromPetdex(action.payload?.slug ?? "");
				if (result.ok && result.petId) {
					catalog = scanPets();
					await writeResult({
						petAction: null,
						availablePets: catalog,
						petId: result.petId,
						importResult: {
							ok: true,
							code: "ok",
							requestId,
							petId: result.petId,
							at: Date.now()
						}
					});
				} else await fail(result.code);
			} catch (error) {
				log.warn("pet import failed (request %s): %s", requestId, error?.message ?? String(error));
				await fail("petdex-failed", error?.message);
			} finally {
				if (activeImportRequest === requestId) activeImportRequest = null;
			}
		}
		stopFullscreenWatch = startFullscreenWatcher((full) => {
			fullscreenForeground = full;
			applyTopmost();
		});
		reconcile(currentSettings).catch((error) => {
			log.warn("desktop-pet startup failed: %s", error?.message ?? String(error));
		});
		return async () => {
			disposed = true;
			clearInterval(petWatch);
			stopFullscreenWatch?.();
			settingsHandle?.dispose();
			unsubscribe?.();
			unregisterCommand?.();
			machine?.dispose();
			await bridge?.stop().catch(() => {});
			await window?.destroy().catch(() => {});
			bridge = void 0;
			window = void 0;
			machine = void 0;
		};
	});
}
//#endregion
export { Config, apply, inject, name };
