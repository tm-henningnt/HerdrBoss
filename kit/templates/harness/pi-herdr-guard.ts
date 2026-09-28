/**
 * Herdr Guard Extension
 *
 * Keeps a Herdr Boss worker inside its worktree. It never asks: a blocked call returns a reason.
 * - read, write, edit, grep, find, and ls may use only the worktree (the Pi working directory),
 *   the temporary directories, and ~/.herdr-boss.
 * - bash may not run the deny list below, and may not name a protected path.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOME = os.homedir();

function real(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		// A path that does not exist yet: resolve its nearest existing parent.
		const parent = path.dirname(p);
		return parent === p ? p : path.join(real(parent), path.basename(p));
	}
}

function expand(p: string, cwd: string): string {
	const home = p === "~" || p.startsWith("~/") ? path.join(HOME, p.slice(1)) : p;
	return real(path.resolve(cwd, home));
}

function tempRoots(): string[] {
	const roots = ["/tmp", "/private/tmp", os.tmpdir()];
	if (process.env.TMPDIR) roots.push(process.env.TMPDIR);
	return [...new Set(roots.map(real))];
}

function inside(p: string, root: string): boolean {
	const rel = path.relative(root, p);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Always blocked, also inside an allowed root.
const PROTECTED = [path.join(HOME, ".config", "herdr-boss"), path.join(HOME, ".pi", "agent", "auth.json")];
const PROTECTED_NAMES = [/(^|\/)auth\.json$/];

const BASH_DENY: [RegExp, string][] = [
	[/\bgit\s+push\b/, "git push"],
	[/\bgit\s+reset\s+[^;&|]*--hard\b/, "git reset --hard"],
	[/\bgit\s+clean\b/, "git clean"],
	[/\bgit\s+branch\s+[^;&|]*-D\b/, "git branch -D"],
	[/\bgit\s+worktree\s+remove\b/, "git worktree remove"],
	[/\bsudo\b/, "sudo"],
	[/\blaunchctl\b/, "launchctl"],
	[/\.config\/herdr-boss\b/, "the private Herdr Boss directory"],
	[/\bauth\.json\b/, "a credential file"],
];

// rm -rf is allowed only when every target is inside a temporary directory or the worktree .worker/tmp.
function rmBlocked(command: string, cwd: string): string | null {
	const rm = /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b([^;&|]*)/g;
	let match: RegExpExecArray | null;
	while ((match = rm.exec(command))) {
		const targets = match[2].trim().split(/\s+/).filter((t) => t && !t.startsWith("-"));
		if (!targets.length) return "rm -rf without a target";
		const allowed = [...tempRoots(), real(path.join(cwd, ".worker", "tmp"))];
		for (const target of targets) {
			if (/[*?$`]/.test(target)) return `rm -rf with a pattern or expansion (${target})`;
			const resolved = expand(target.replace(/^['"]|['"]$/g, ""), cwd);
			if (!allowed.some((root) => inside(resolved, root) && resolved !== root)) return `rm -rf outside the temporary directories (${target})`;
		}
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const cwd = real(ctx.cwd);
		const roots = [cwd, ...tempRoots(), real(path.join(HOME, ".herdr-boss"))];

		if (event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			for (const [pattern, name] of BASH_DENY) {
				if (pattern.test(command)) return { block: true, reason: `Herdr guard: ${name} is not allowed for a worker. Ask your orchestrator.` };
			}
			const rm = rmBlocked(command, cwd);
			if (rm) return { block: true, reason: `Herdr guard: ${rm}. Ask your orchestrator.` };
			return undefined;
		}

		if (["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)) {
			const raw = event.input.path;
			if (typeof raw !== "string" || !raw) return undefined;
			const target = expand(raw, cwd);
			if (PROTECTED.some((p) => inside(target, real(p))) || PROTECTED_NAMES.some((p) => p.test(target))) {
				return { block: true, reason: `Herdr guard: ${raw} is a protected path.` };
			}
			if (!roots.some((root) => inside(target, root))) {
				return { block: true, reason: `Herdr guard: ${raw} is outside the worktree. Work only in ${cwd}, the temporary directories, or ~/.herdr-boss.` };
			}
		}
		return undefined;
	});
}
