# 23: Start a Boss and project orchestrators inside a factory

**What to build:** `factory boss start NAME` starts a Boss session in a factory. A factory without a Boss session cannot run projects.

**Blocked by:** 10: Factory wizard and harness login; 15: Service and image updates. The command also waits for the Owner's harness logins (exit code 3).

**Status:** ready-for-agent

## Command

`herdr-boss factory boss start NAME [--harness claude|codex] [--resume] [--dry-run]`

The command runs on the host and uses the host transport. It changes only the labeled container of the factory.

## Steps

The command runs these steps in order. A finished step is skipped when its check still passes.

1. Check that the harness login of the chosen harness works. When it does not, exit with code 3 and post one Mailbox item that names the `factory login NAME HARNESS` command.
2. Install the Herdr Boss kit in the factory (`herdr-boss kit install` inside the container), for the Boss pane and for each project.
3. Check that the Herdr server in the container runs. Create the `Boss` workspace and the pane labeled `boss` when they are absent.
4. Start the harness in the `boss` pane with the Boss prompt and the kit rules.
5. Check that the pane shows a ready prompt. Retry the verified Enter at most 3 times, 20 seconds apart. When the text stays unsent, exit with code 3.

The command never starts a second Boss pane. When a live `boss` pane exists, it prints its state and exits with code 0.

## Acceptance

- [ ] `factory boss start NAME` runs the five steps through the fake transport and the real Docker call plan. A test covers each step skipped and each step failed.
- [ ] A missing harness login exits with code 3 and posts one Mailbox item with no secret.
- [ ] A factory without the kit gets the kit installed once. A second run installs nothing.
- [ ] The project new flow runs inside the factory: the Boss in the factory starts project orchestrators with `herdr-boss project new`. A test with the fake transport checks the call plan.
- [ ] A handover inside the factory works the same as on factory zero. The factory keeps its own handover state. Tests check that the state paths stay inside the container volumes.
- [ ] `--dry-run` prints the plan and changes nothing.
- [ ] The image update (ticket 15) prints the `factory boss start NAME` command in place of the manual instruction.
- [ ] A live run on a throwaway factory waits for the Owner's harness logins.

Update `docs/cli.md`, `docs/user-guide.md`, and the dashboard help in the same change as the behaviour.

Follow the Docker safety rule in the README.
