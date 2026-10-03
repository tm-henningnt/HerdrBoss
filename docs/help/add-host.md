# Add a host help

The page Add a host guides you through the preparation of a computer that runs factories. Open it from the link on the Fleet page. The page address is `/fleet/add-host`.

## Choose the host type

Choose Windows with WSL2, Linux, or Mac with OrbStack. Each type has its own list of steps. Type a machine label. The label is the name of the host in the registry. Select **Start the guide**. A saved guide shows in the list **Continue a saved guide**.

The host type cannot change after you mark a step as done. Select **Delete this guide and its saved values** to start again.

## Do the steps

Each step shows what to do, why, the exact commands, and what you should see. Select the copy button of a command to copy it. The page fills each command with your values. A value that is not typed yet shows as a marked name in angle brackets.

A step with a warning has a risk that is hard to undo. Read the warning before you run the command. Open **Something went wrong** for the three most common errors of the step and their fixes.

Select the box **Step N is done** after the check of the step passes. You can mark a step only after the steps before it. The progress of the guide is saved on this machine in the Herdr Boss data directory. Close the page and come back later.

## Type your values

Some steps ask for a value: the machine label, the role, the Linux user, the tailnet name, the key fingerprint, versions, memory and CPU limits, and account names. The page checks the format while you type. A green mark means the format is correct. A red mark and a message mean that it is not. The page saves a value with a correct format.

The page never asks for a secret. Type a fingerprint line, not a key. Type an account name, not a password. A value that looks like a secret is refused. Keep keys, passwords, and tokens on the host and on your Mac.

## Test from this machine

Register the host first. Run `herdr-boss factory host add LABEL --from-file -` on the Mac. Select **Test from this machine**. The page runs these checks with the host tool:

1. The host answers on the tailnet name.
2. Key login works.
3. Docker answers over the Docker context.
4. The systemd state is running. The only accepted failed unit is `systemd-binfmt.service`.
5. The Docker memory is the limit that you typed.
6. SSH password login is off.

Each check shows a green mark, a red mark, or a grey mark for a check that did not run. A red check shows the failing command, the masked output, and the next step. The output never shows the address, the key path, or the context name.

## Terminate and wait

The step Create the boot task has a test that stops WSL on purpose. Run `wsl --terminate DISTRO` in PowerShell on the host. This stops all WSL work on the host. Select **I ran the command: start the wait**. The page checks the host every 10 seconds. It shows when the repeating trigger starts WSL again. The test fails after 7 minutes.

## Reboot test

The step Reboot test checks that the host returns after a restart. Arrange the restart with the host operator. Select **I am restarting the host now**, then restart the host. Do not sign in. The test passes when the host started after your click and Docker answers. It shows the recovery time.

## Answers and table

The last step builds the registry entry and a table of your answers. The page sends nothing. You run the command. The table holds private values: keep it in your private notes and do not commit it. Next, run `herdr-boss factory new NAME --host LABEL`.

## The preview

The read-only preview shows the text and the commands. It saves no progress and runs no test. The page needs the Owner session. A token session gets a message and no guide. The Owner session is the dashboard page on the machine that runs Herdr Boss, or a page with a login session.
