/**
 * Herdr Guard Extension
 *
 * Keeps a Herdr Boss worker inside its worktree. It never asks: a blocked call returns a reason.
 * Each reason names the form that the worker may run instead (the `Allowed instead` clause).
 * - read, write, edit, grep, find, and ls may use only the worktree (the Pi working directory),
 *   the temporary directories, and ~/.herdr-boss.
 * - bash may not run the deny list below, and may not name a protected path.
 * - bash may not run rm -rf on a pattern, on the worktree, or on the .worker folder itself. It may run
 *   rm -rf on a path inside the worktree .worker folder, and on a path inside a temporary directory.
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

// Each entry holds the pattern, the name that the reason uses, and the form that a worker may run instead.
const BASH_DENY: [RegExp, string, string][] = [
	[/\bgit\s+push\b/, "git push", "the orchestrator pushes a reviewed branch"],
	[/\bgit\s+reset\s+[^;&|]*--hard\b/, "git reset --hard", "the orchestrator restores a file in the main checkout"],
	[/\bgit\s+clean\b/, "git clean", "the orchestrator removes untracked files after review"],
	[/\bgit\s+branch\s+[^;&|]*-D\b/, "git branch -D", "the orchestrator deletes a branch after review"],
	[/\bgit\s+worktree\s+remove\b/, "git worktree remove", "herdr-boss worktree prune"],
	[/\bsudo\b/, "sudo", "no form for a worker; the orchestrator or the Owner runs it"],
	[/\blaunchctl\b/, "launchctl", "no form for a worker; the Boss restarts the service"],
	[/\.config\/herdr-boss\b/, "the private Herdr Boss directory", "no path for a worker; read the project kit in the worktree"],
	[/\bauth\.json\b/, "a credential file", "no path for a worker; a credential file holds a secret"],
	[/\bpkill\b/, "pkill (stop your process by its saved PID)", "kill <pid> of a process that you started, with the PID you saved (pgrep -l NAME shows the PID)"],
	[/\bkillall\b/, "killall (stop your process by its saved PID)", "kill <pid> of a process that you started, with the PID you saved (pgrep -l NAME shows the PID)"],
	[/\bkill\b[^;&|]*\$\(\s*pgrep\b/, "kill with a pgrep name pattern", "kill <pid> with the PID you saved, after pgrep -l NAME names it"],
];

// rm -rf is allowed only when every target is inside a temporary directory or inside the worktree .worker folder.
// The reason body starts with `rm -rf`, and the allowed clause names one exact path form.
function rmBlocked(command: string, cwd: string): { body: string; allowed: string } | null {
	const rm = /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b([^;&|]*)/g;
	let match: RegExpExecArray | null;
	while ((match = rm.exec(command))) {
		const targets = match[2].trim().split(/\s+/).filter((t) => t && !t.startsWith("-"));
		if (!targets.length) return { body: "rm -rf without a target", allowed: "name one exact path, for example rm -rf .worker/tmp/scratch" };
		// Each root is a boundary: the folder itself stays blocked, only its child folders are allowed.
		const allowed = [...tempRoots(), real(path.join(cwd, ".worker"))];
		for (const target of targets) {
			if (/[*?$`]/.test(target)) return { body: `rm -rf with a pattern or expansion (${target})`, allowed: "drop the pattern and name the exact path, for example rm -rf .worker/tmp/scratch" };
			const resolved = expand(target.replace(/^['"]|['"]$/g, ""), cwd);
			if (!allowed.some((root) => inside(resolved, root) && resolved !== root)) return { body: `rm -rf outside the temporary directories and the worktree .worker folder (${target})`, allowed: "rm -rf on an exact path inside the worktree .worker folder, for example rm -rf .worker/tmp/scratch, or inside a temporary directory" };
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
			for (const [pattern, name, allowed] of BASH_DENY) {
				if (pattern.test(command)) return { block: true, reason: `Herdr guard: ${name} is not allowed for a worker. Allowed instead: ${allowed}. Ask your orchestrator.` };
			}
			const rm = rmBlocked(command, cwd);
			if (rm) return { block: true, reason: `Herdr guard: ${rm.body}. Allowed instead: ${rm.allowed}. Ask your orchestrator.` };
			return undefined;
		}

		if (["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)) {
			const raw = event.input.path;
			if (typeof raw !== "string" || !raw) return undefined;
			const target = expand(raw, cwd);
			if (PROTECTED.some((p) => inside(target, real(p))) || PROTECTED_NAMES.some((p) => p.test(target))) {
				return { block: true, reason: `Herdr guard: ${raw} is a protected path. Allowed instead: a non-protected path in the worktree, a temporary directory, or ~/.herdr-boss.` };
			}
			if (!roots.some((root) => inside(target, root))) {
				return { block: true, reason: `Herdr guard: ${raw} is outside the worktree. Allowed instead: a path in ${cwd}, a temporary directory, or ~/.herdr-boss.` };
			}
		}
		return undefined;
	});
}
