// The text of the "Add a host" guide. Edit the words here. The code reads this file only.
// Step names of the Windows list are the headings of docs/windows-host.md. A test compares them.
// A command is { shell, text }. A word in angle brackets, for example <HOST_FQDN>, is replaced with the value that the user typed.
// own: true marks a command that docs/windows-host.md does not hold. A test checks every other command against that file.
// No private value belongs in this file: use placeholders only.

export const HOST_TYPES = [
  { id: 'windows-wsl2', title: 'Windows with WSL2', runtime: 'docker-engine-wsl2', summary: 'A Windows 11 computer that runs Docker Engine in Ubuntu on WSL2.', steps: ['bios', 'update-windows', 'never-sleep', 'active-hours', 'install-wsl', 'install-ubuntu', 'systemd', 'limit-memory', 'docker-repository', 'install-docker', 'configure-docker', 'mac-tailscale', 'magicdns', 'access-policy', 'ubuntu-tailscale', 'ssh-key', 'public-key', 'ssh-server', 'ssh-order', 'ssh-config', 'boot-task', 'test', 'reboot-test', 'machine-facts', 'answers'] },
  { id: 'linux', title: 'Linux', runtime: 'docker-engine', summary: 'A Linux computer with Docker Engine. It needs the Docker, Tailscale, and SSH steps only.', steps: ['linux-update', 'linux-never-sleep', 'docker-repository', 'install-docker-unix', 'configure-docker-unix', 'mac-tailscale', 'magicdns', 'access-policy', 'linux-tailscale', 'ssh-key', 'public-key', 'ssh-server', 'ssh-order', 'ssh-config', 'test', 'linux-reboot-test', 'machine-facts', 'answers'] },
  { id: 'mac-orbstack', title: 'Mac with OrbStack', runtime: 'orbstack', summary: 'A second Mac that runs OrbStack. Start one factory at a time.', steps: ['orbstack-install', 'orbstack-memory', 'mac-tailscale', 'magicdns', 'access-policy', 'host-mac-tailscale', 'ssh-key', 'host-mac-ssh', 'ssh-config', 'test', 'mac-reboot-test', 'machine-facts', 'answers'] },
];

// Words that show a tooltip in the step text. The page marks the first use in each step.
export const GLOSSARY = [
  { term: 'WSL', text: 'Windows Subsystem for Linux. It runs a real Linux system inside Windows. The factory host uses it to run Docker.' },
  { term: 'systemd', text: 'The program that starts and watches services in Linux. Docker, SSH, and Tailscale start through it.' },
  { term: 'Tailscale', text: 'A private network between your own computers. Each computer gets a name that only your devices can reach.' },
  { term: 'SSH key', text: 'A pair of files that replaces a password. The private file stays on your Mac. The public file goes to the host.' },
  { term: 'Docker context', text: 'A saved setting that tells the Docker command on your Mac which computer to talk to.' },
];

// The 15 host checks of the factory chapter. step names the step in the Windows list that holds the work.
export const HOST_CHECKS = [
  { id: 'H1', text: 'WSL never stops when idle.', step: 'limit-memory' },
  { id: 'H2', text: 'The boot task runs as your own Windows account, also when you are signed out.', step: 'boot-task' },
  { id: 'H3', text: 'With remote desktop, disconnect and never sign out. Windows 10 22H2 is for tests only.', step: 'never-sleep' },
  { id: 'H4', text: 'Optional: mask systemd-binfmt.service so that systemd reports running.', step: 'systemd' },
  { id: 'H5', text: 'Tailscale runs inside Ubuntu with the tag tag:factory and key expiry off.', step: 'ubuntu-tailscale' },
  { id: 'H6', text: 'The factory user has the Tailscale operator right and Serve is on.', step: 'ubuntu-tailscale' },
  { id: 'H7', text: 'The Mac reaches tag:factory on ports 22, 4477, and 4478.', step: 'access-policy' },
  { id: 'H8', text: 'MagicDNS and HTTPS certificates are on. The tailnet name resolves on the Mac.', step: 'magicdns' },
  { id: 'H9', text: 'One SSH key for each host. The SSH server takes keys only and starts after Tailscale.', step: 'ssh-server' },
  { id: 'H10', text: 'The Mac has a Docker context for the host.', step: 'ssh-config' },
  { id: 'H11', text: 'The factory user is in the docker group. Docker log rotation is on.', step: 'install-docker' },
  { id: 'H12', text: 'Docker safety: no prune or remove command on a shared daemon. Label each resource.', step: 'docker-repository' },
  { id: 'H13', text: 'The code volume has Git as the factory user, an origin remote, and fast-forward updates. Check it in the factory chapter.', step: 'answers' },
  { id: 'H14', text: 'Each agent app is signed in at the host terminal. Check it in the factory chapter.', step: 'answers' },
  { id: 'H15', text: 'The factory joins the Fleet page. Check it in the factory chapter.', step: 'answers' },
];

export const DOCKER_SAFETY = 'Docker safety (H12): run no `docker system prune`, `docker builder prune`, `docker image prune`, `docker container prune`, `docker volume prune`, `docker rm`, `docker rmi`, or `docker volume rm` on a shared daemon. Put a label on each Docker resource that you create.';

const err = (problem, fix) => ({ problem, fix });

const dockerRepository = {
  id: 'docker-repository', name: 'Add the Docker repository', where: 'Ubuntu', h: ['H12'],
  warning: DOCKER_SAFETY,
  what: 'Add the official Docker package source to Ubuntu. Run the commands inside Ubuntu.',
  why: 'The Docker package of Ubuntu is old. The Docker repository gives the current version.',
  commands: [{ shell: 'ubuntu', text: 'sudo apt-get update\nsudo apt-get install -y ca-certificates curl\nsudo install -m 0755 -d /etc/apt/keyrings\nsudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc\nsudo chmod a+r /etc/apt/keyrings/docker.asc\necho "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null\nsudo apt-get update' }],
  expected: 'The command `apt-cache policy docker-ce` lists a candidate version from download.docker.com.',
  errors: [
    err('curl prints "Could not resolve host".', 'Ubuntu has no network. Run `ping -c 1 download.docker.com`. Check the VPN and the DNS setting of Windows.'),
    err('apt-get prints "NO_PUBKEY" or a GPG error.', 'Download the key again with the curl command. Check that /etc/apt/keyrings/docker.asc exists and that `chmod a+r` ran.'),
    err('`apt-cache policy docker-ce` shows no candidate.', 'Read /etc/apt/sources.list.d/docker.list. The release name must be one that Docker supports. Run `sudo apt-get update` again.'),
  ],
};

const installDocker = {
  id: 'install-docker', name: 'Install Docker', where: 'Ubuntu', h: ['H11'],
  what: 'Install Docker Engine. Give the factory user the right to run Docker. Do not install Docker Desktop for this host.',
  why: 'The factory host tool talks to Docker Engine over SSH. Docker Desktop does not give that connection.',
  warning: 'Docker group membership gives control of the host. Give it only to the account that the host tool uses.',
  commands: [{ shell: 'ubuntu', text: 'sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin\nsudo systemctl enable --now docker\nsudo usermod -aG docker <FACTORY_USER>' }],
  fields: [],
  expected: 'Start a new login for the group change. Then `docker version` works as the factory user with no sudo.',
  errors: [
    err('`docker version` prints "permission denied" on the socket.', 'The group change needs a new login. Close Ubuntu. Run `wsl --terminate <DISTRO>` in PowerShell. Open Ubuntu again.'),
    err('`docker version` prints "Cannot connect to the Docker daemon".', 'Run `sudo systemctl status docker`. If systemd does not run, repeat the step "Turn on systemd".'),
    err('apt-get cannot find the package docker-ce.', 'The Docker repository is missing. Repeat the step "Add the Docker repository".'),
  ],
};

const configureDocker = {
  id: 'configure-docker', name: 'Configure and test Docker', where: 'Ubuntu', h: ['H11'],
  what: 'Turn on log rotation. Run the test container. Read the memory that Docker sees.',
  why: 'Log files without a limit fill the disk. The memory value proves that the WSL limit works.',
  commands: [
    { shell: 'file /etc/docker/daemon.json', text: '{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }' },
    { shell: 'ubuntu', text: 'sudo systemctl restart docker\ndocker run --rm --label herdr-factory-spike=<WORKER> hello-world\ndocker info --format \'{{.MemTotal}}\'' },
  ],
  expected: 'The container `hello-world` prints its greeting. `docker info` shows the memory limit of the step "Limit memory and CPU".',
  errors: [
    err('Docker does not restart after the change.', 'The file daemon.json has a JSON error. Run `sudo systemctl status docker`. Fix the file. Run the restart again.'),
    err('`hello-world` cannot download.', 'Ubuntu has no network, or a proxy blocks Docker Hub. Run `ping -c 1 registry-1.docker.io`.'),
    err('`docker info` shows more memory than the limit.', 'The `.wslconfig` file did not apply. Run `wsl --shutdown` in PowerShell. Open Ubuntu again.'),
  ],
};

const installDockerUnix = {
  ...installDocker, id: 'install-docker-unix',
  errors: [
    err('`docker version` prints "permission denied" on the socket.', 'The group change needs a new login. Log out and log in again. Run `docker version` again.'),
    installDocker.errors[1],
    installDocker.errors[2],
  ],
};

const configureDockerUnix = {
  ...configureDocker, id: 'configure-docker-unix',
  expected: 'The container `hello-world` prints its greeting. `docker info` shows the memory of the host.',
  errors: [
    configureDocker.errors[0],
    configureDocker.errors[1],
    err('`docker info` shows an unexpected memory value.', 'Run `free -h` on the host. Docker shows the memory of the host or of the virtual machine that it runs in.'),
  ],
};

const macTailscale = {
  id: 'mac-tailscale', name: 'Put the Mac on Tailscale', where: 'Mac', fields: ['macName'],
  what: 'Install Tailscale on your controlling Mac. Sign in with your own Tailscale account. Only you do this step.',
  why: 'The Mac reaches the host over the private Tailscale network. The host has no public address.',
  commands: [{ shell: 'mac', text: 'tailscale status' }],
  expected: 'The command `tailscale status` on the Mac lists the Mac as connected.',
  errors: [
    err('The Mac prints "command not found: tailscale".', 'The app has no command line tool in the path. Run `/Applications/Tailscale.app/Contents/MacOS/Tailscale status`.'),
    err('The status shows "Logged out".', 'Open the Tailscale app. Sign in with your own account.'),
    err('The Mac shows as stopped or offline.', 'Open the Tailscale menu on the Mac. Turn Tailscale on.'),
  ],
};

const magicDns = {
  id: 'magicdns', name: 'Turn on MagicDNS and HTTPS', where: 'Tailscale admin console', h: ['H8'], fields: ['tailnetName'],
  what: 'Open the Tailscale admin console. Open DNS. Turn on MagicDNS. Turn on HTTPS certificates.',
  why: 'MagicDNS gives the host a name. The Mac and the factory use that name instead of an address.',
  commands: [{ shell: 'mac', text: 'ping -c 1 <HOST_FQDN>' }],
  expected: 'After the step "Install Tailscale in Ubuntu", the tailnet name of the host resolves on the Mac.',
  errors: [
    err('The option HTTPS certificates is missing.', 'Turn on MagicDNS first. Then scroll down on the DNS page to HTTPS Certificates.'),
    err('`ping` prints "cannot resolve".', 'Check that Tailscale runs on the Mac and that MagicDNS is on. Check the spelling of the name.'),
    err('You do not know the tailnet name.', 'The DNS page shows the tailnet name. The host name is the machine name, a dot, and the tailnet name.'),
  ],
};

const accessPolicy = {
  id: 'access-policy', name: 'Write the access policy', where: 'Tailscale admin console', h: ['H7'], fields: ['tailscaleAccount'],
  warning: 'A wrong policy can cut your devices off from each other. Copy the old policy text before you save. Only you edit the policy.',
  what: 'Let the Mac reach tag:factory on ports 22, 4477, and 4478. Add these lines to the tailnet policy file. Save the policy.',
  why: 'Tailscale blocks all traffic that a rule does not allow. The rule tests prove that the Mac has access.',
  commands: [
    { shell: 'policy', text: '"tagOwners": { "tag:factory": ["autogroup:admin"] },\n"grants": [\n  { "src": ["autogroup:member"], "dst": ["tag:factory"], "ip": ["tcp:22", "tcp:4477", "tcp:4478"] }\n],\n"tests": [\n  { "src": "<OWNER_LOGIN>", "accept": ["tag:factory:22", "tag:factory:4477", "tag:factory:4478"] }\n]' },
    { shell: 'mac', text: 'nc -vz <HOST_FQDN> 4478' },
  ],
  expected: 'The rule tests pass for each port. After the step "Install Tailscale in Ubuntu", `nc -vz` prints "Refused". Refused means the Mac reached the host. A timeout means the rule is missing.',
  errors: [
    err('The editor reports a syntax error.', 'The policy file has each section once. Put the new entries inside the existing tagOwners and grants sections.'),
    err('A rule test fails.', 'The login in the test must be your Tailscale login. Change the value of src.'),
    err('`nc -vz` times out.', 'The rule or the tag is missing. Check the policy and the tag of the host in the admin console.'),
  ],
};

const sshKey = {
  id: 'ssh-key', name: 'Make the SSH key on the Mac', where: 'Mac', h: ['H9'], fields: ['keyName', 'alias', 'fingerprint'],
  warning: 'Never print the private key. Never copy it into a chat. Never type it on this page. Add the folder to the read deny rules of your agent apps.',
  what: 'Make one SSH key for this host. Keep it in a Mac folder that agents cannot read.',
  why: 'The host accepts a key and no password. One key for each host limits the damage if a key is lost.',
  commands: [{ shell: 'mac', text: 'mkdir -m 700 -p ~/.ssh/herdr-factory\nssh-keygen -t ed25519 -f ~/.ssh/herdr-factory/<KEY_NAME> -C "herdr-factory-<HOST_ALIAS>"\nssh-keygen -l -f ~/.ssh/herdr-factory/<KEY_NAME>.pub' }],
  expected: 'The last command prints one fingerprint line. Paste only that line in the field.',
  errors: [
    err('`ssh-keygen` asks for a passphrase.', 'The host tool runs ssh in batch mode. Use an empty passphrase, or load the key into ssh-agent before the tests.'),
    err('`ssh-keygen` says the file already exists.', 'Do not overwrite it. Use another key name.'),
    err('`ssh-keygen` says "No such file or directory".', 'The folder does not exist. Run the `mkdir` command first.'),
  ],
};

const publicKey = {
  id: 'public-key', name: 'Add the public key to Ubuntu', where: 'Mac, then Ubuntu', h: ['H9'],
  what: 'Copy the public key on the Mac. Paste it into the authorized_keys file of the factory user in Ubuntu.',
  why: 'The host lets in only the keys that this file lists.',
  commands: [
    { shell: 'mac', text: 'pbcopy < ~/.ssh/herdr-factory/<KEY_NAME>.pub' },
    { shell: 'ubuntu', text: 'install -d -m 700 ~/.ssh\nnano ~/.ssh/authorized_keys\nchmod 600 ~/.ssh/authorized_keys' },
  ],
  expected: 'The public key is one line. `ls -ld ~/.ssh ~/.ssh/authorized_keys` shows `drwx------` and `-rw-------`.',
  errors: [
    err('The key is on two lines in the file.', 'The editor wrapped the line. Paste again. The public key must be one line.'),
    err('Login later fails with "Permission denied (publickey)".', 'Run `ls -ld ~/.ssh ~/.ssh/authorized_keys`. The folder must be mode 700 and the file mode 600. Both belong to the factory user.'),
    err('`pbcopy` copies nothing.', 'The path of the .pub file is wrong. Run `ls ~/.ssh/herdr-factory`.'),
  ],
};

const sshServer = {
  id: 'ssh-server', name: 'Install the SSH server', where: 'Ubuntu', h: ['H9'],
  warning: 'Keep the setup session open until key login works from the Mac. A wrong SSH setting can lock you out.',
  what: 'Install the SSH server. Make it accept keys only. Check the file, then reload SSH.',
  why: 'A host that accepts passwords can be opened by a password guess.',
  commands: [
    { shell: 'ubuntu', text: 'sudo apt-get install -y openssh-server\nsudo systemctl enable --now ssh' },
    { shell: 'file /etc/ssh/sshd_config.d/00-herdr-factory.conf', text: 'PubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers <FACTORY_USER>' },
    { shell: 'ubuntu', text: 'sudo sshd -t\nsudo systemctl reload ssh\nsudo sshd -T | grep -i passwordauthentication' },
  ],
  expected: 'The last command prints `passwordauthentication no`.',
  errors: [
    err('`sudo sshd -t` prints an error.', 'Fix the file. Do not reload SSH until the check prints nothing.'),
    err('`sshd -T` prints `passwordauthentication yes`.', 'Another file in /etc/ssh/sshd_config.d sets it first. The first value wins. Keep the 00- prefix on the name of your file.'),
    err('SSH does not start.', 'Run `sudo systemctl status ssh`. Read the error line. Fix the file named in it.'),
  ],
};

const sshOrder = {
  id: 'ssh-order', name: 'Let SSH start after Tailscale', where: 'Ubuntu', h: ['H9'],
  what: 'Tell systemd to start SSH after Tailscale. Run `sudo systemctl edit ssh`. Add the lines. Save the file. Restart SSH.',
  why: 'SSH must listen on the Tailscale address. It cannot do this before Tailscale starts.',
  commands: [
    { shell: 'file ssh.service override', text: '[Unit]\nAfter=tailscaled.service\nWants=tailscaled.service' },
    { shell: 'ubuntu', text: 'sudo systemctl restart ssh\nsystemctl show ssh -p After' },
  ],
  expected: 'The command `systemctl show ssh -p After` lists `tailscaled.service`.',
  errors: [
    err('The editor opens and you cannot save.', 'Put the lines above the comment line that the editor shows. Save with Ctrl+O. Close with Ctrl+X.'),
    err('`systemctl show` does not list tailscaled.service.', 'The override file did not save. Run `sudo systemctl edit ssh` again.'),
    err('SSH does not start after the change.', 'Run `sudo systemctl status ssh`. Remove the override with `sudo systemctl revert ssh` and try again.'),
  ],
};

const sshConfig = {
  id: 'ssh-config', name: 'Tell the Mac which key to use', where: 'Mac', h: ['H10'], fields: ['context'],
  what: 'Add an entry to the SSH config file on the Mac. Make a Docker context for the host.',
  why: 'The entry gives the host a short name and picks the right key. The Docker context lets the Docker command on the Mac use the host.',
  commands: [
    { shell: 'file ~/.ssh/config', text: 'Host <HOST_ALIAS>\n  HostName <HOST_FQDN>\n  User <FACTORY_USER>\n  IdentityFile ~/.ssh/herdr-factory/<KEY_NAME>\n  IdentitiesOnly yes' },
    { shell: 'mac', text: 'docker context create <CONTEXT> --docker "host=ssh://<HOST_ALIAS>"' },
  ],
  expected: '`ssh <HOST_ALIAS> uname -m` prints `x86_64` with no password question. `docker --context <CONTEXT> ps` works without a password.',
  errors: [
    err('SSH asks "Are you sure you want to continue connecting".', 'This is the first connection. Answer yes once. The host tool does this by itself later.'),
    err('SSH prints "Permission denied (publickey)".', 'Check the IdentityFile path. Check that the public key is in authorized_keys of the factory user.'),
    err('`docker context create` says the context exists.', 'Use another context name.'),
  ],
};

const machineFacts = {
  id: 'machine-facts', name: 'Collect the machine facts', where: 'Mac and host', fields: ['ubuntuVersion', 'dockerVersion', 'tailscaleVersion', 'wslVersion'],
  what: 'Run the commands. Type the versions in the fields. Keep the output in your private notes.',
  why: 'The versions tell you what to update when a host behaves differently from the others.',
  commands: [
    { shell: 'mac', text: 'herdr-boss factory ssh <HOST> -- \'lsb_release -d; uname -r; nproc; free -h\'\nherdr-boss factory ssh <HOST> -- \'docker version --format "{{.Server.Version}}"; tailscale version\'' },
    { shell: 'powershell', text: 'wsl --version\nwinver', types: ['windows-wsl2'] },
  ],
  expected: 'Each command prints a result. Do not copy an address or a name into a repository.',
  errors: [
    err('`herdr-boss factory ssh` says the host is not in the registry.', 'Register the host first. See the step "Test from the Mac".'),
    err('`lsb_release` is not found.', 'Run `cat /etc/os-release` instead and read the VERSION_ID line.'),
    err('`winver` shows a window and no text.', 'Read the version and build in the window. Type the Windows version in your notes.'),
  ],
};

const rebootTest = {
  id: 'reboot-test', name: 'Reboot test', where: 'Host and this page', h: ['H2', 'H9'],
  warning: 'A restart stops all work on the host. Arrange the restart with the host operator. Do not interrupt the work of another factory.',
  what: 'Restart the host. Do not sign in. Wait. The button below records the time of the restart and checks the host.',
  why: 'A Docker restart does not prove that the host returns after a power loss or an update.',
  commands: [{ shell: 'powershell', text: 'Restart-Computer', own: true }],
  reboot: true,
  expected: 'From the Mac, SSH accepts key login and `docker ps` works. The check records the recovery time.',
  errors: [
    err('The host does not answer after 15 minutes.', 'The boot task did not start WSL. Sign in at the machine. Open Task Scheduler. Read the Last Run Result of the task.'),
    err('SSH answers but Docker does not.', 'The boot task starts docker. Check the program arguments of the task.'),
    err('The host answers only after you sign in.', 'The task runs only when the user is signed in. Select "Run whether user is logged on or not".'),
  ],
};

const otherReboot = (id, restart, where) => ({
  ...rebootTest, id, where,
  commands: [{ shell: 'ubuntu', text: restart, own: true }],
  errors: [
    err('The host does not answer after 15 minutes.', 'Go to the machine. Check the power and the network. Check that Tailscale starts at boot.'),
    err('SSH answers but Docker does not.', 'Docker did not start at boot. Run `sudo systemctl enable docker` (Linux) or start the OrbStack app (Mac).'),
    err('The host answers only after you sign in.', 'A service waits for a sign-in. Turn on automatic login for the Mac, or enable the services at boot on Linux.'),
  ],
});

const test = {
  id: 'test', name: 'Test from the Mac', where: 'Mac and this page', h: ['H9', 'H10', 'H11'],
  what: 'Register the host on the Mac. Then press the button "Test from this machine".',
  why: 'The test runs the same commands that the factory wizard runs. A failure here is cheaper to fix than a failure in the wizard.',
  warning: 'Type the address, the user, and the key file on the private input of the command. Never type them in a chat or on this page.',
  commands: [
    { shell: 'mac', text: 'herdr-boss factory host add <HOST> --from-file -\nherdr-boss factory host add <HOST> --docker-context <CONTEXT>' },
    { shell: 'mac', text: 'herdr-boss factory ssh <HOST> -- uname -m\nherdr-boss factory ssh <HOST> -- systemctl is-active docker ssh tailscaled\nherdr-boss factory ssh <HOST> -- sudo sshd -T\ndocker context ls --format \'{{.Name}}\'\ndocker --context <CONTEXT> ps --format \'{{.ID}} {{.Status}}\'' },
  ],
  testPanel: true,
  expected: 'Each check is green. On a Windows host the architecture is x86_64. Each service is active. `sshd -T` shows `passwordauthentication no`.',
  errors: [
    err('The check says the host is not in the registry.', 'Run the first command. Type the fields address, user, and keyFile as JSON on the private input. End the input with Ctrl+D.'),
    err('The check says the host does not answer.', 'Check that Tailscale runs on the Mac and on the host. Check the boot task. Check the access policy.'),
    err('The check says key login fails.', 'Check the key file path in the registry, the authorized_keys file, and the SSH config entry.'),
  ],
};

const answers = {
  id: 'answers', name: 'Answers and table', where: 'This page', h: ['H13', 'H14', 'H15'],
  what: 'Read the table of your answers. Copy the registry entry. This page sends nothing: you run the command.',
  why: 'The table is your private record of the host. The registry entry is the input of the factory wizard.',
  warning: 'The table holds private values. Keep it in your private notes. Do not commit it.',
  answersPanel: true,
  expected: 'No field is missing. The next step is `herdr-boss factory new` with the label of this host. See the factory chapter for H13, H14, and H15.',
  errors: [
    err('A field shows a red mark.', 'Read the message under the field. Change the value to the shown format.'),
    err('The table lists a missing field.', 'Open the step that collects that field. Type the value.'),
    err('`factory host add` says the host is already in the registry.', 'Run `herdr-boss factory host remove <HOST>`. Add the host again.'),
  ],
};

const windowsOnly = {
  bios: {
    id: 'bios', name: 'BIOS', where: 'At the machine',
    what: 'Turn on CPU virtualization in the BIOS. The name differs by maker: Intel VT-x, AMD-V, or SVM Mode. If the BIOS has the option, set the computer to power on after a power loss. Do this at the machine.',
    why: 'WSL needs CPU virtualization. A host that stays off after a power loss does not come back by itself.',
    commands: [],
    expected: 'In Task Manager, open Performance, then CPU. It shows `Virtualization: Enabled`.',
    errors: [
      err('Task Manager shows `Virtualization: Disabled`.', 'The BIOS did not save the setting. Enter the BIOS again. Turn the option on. Save and exit.'),
      err('You cannot find the option.', 'Look for Intel VT-x, AMD-V, SVM Mode, or Virtualization Technology. Read the manual of the main board.'),
      err('The BIOS has a password.', 'Ask the owner of the computer. Do not try to reset the BIOS.'),
    ],
  },
  'update-windows': {
    id: 'update-windows', name: 'Update Windows', where: 'Windows', h: ['H3'],
    warning: 'Windows 10 22H2 has no support (H3). Use it for tests only. `herdr-boss doctor` warns on Windows 10.',
    what: 'Open Settings, then Windows Update. Install all updates. Restart. Repeat until no update is left.',
    why: 'WSL2 needs a current Windows. An old Windows can also restart for an update at a bad time.',
    commands: [],
    expected: 'Windows Update shows "You\'re up to date".',
    errors: [
      err('An update stays at one percent for a long time.', 'Wait one hour. Then restart the computer and run Windows Update again.'),
      err('An update fails with an error code.', 'Run the Windows Update troubleshooter in Settings, then System, then Troubleshoot.'),
      err('Windows says there is not enough space.', 'Free disk space. Windows Update shows the space that it needs.'),
    ],
  },
  'never-sleep': {
    id: 'never-sleep', name: 'Never sleep', where: 'PowerShell as administrator', h: ['H3'],
    warning: 'With remote desktop, disconnect. Never sign out (H3). A sign-out can end work that runs on the host.',
    what: 'Turn off standby and hibernation when the computer has mains power.',
    why: 'A computer that sleeps cannot answer the Mac.',
    commands: [{ shell: 'powershell', text: 'powercfg /change standby-timeout-ac 0\npowercfg /change hibernate-timeout-ac 0\npowercfg /hibernate off' }],
    expected: '`powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` shows `Current AC Power Setting Index: 0x00000000`.',
    errors: [
      err('The command prints "Access is denied".', 'The window is not elevated. Open PowerShell with Run as administrator.'),
      err('The query shows another value.', 'Another power plan is active. Run `powercfg /getactivescheme`. Run the commands again for that plan.'),
      err('The host sleeps when it runs on battery.', 'The commands set mains power only. Keep the computer on mains power.'),
    ],
  },
  'active-hours': {
    id: 'active-hours', name: 'Active hours', where: 'Windows',
    what: 'Open Settings, then Windows Update, then Advanced options, then Active hours. Set the longest range that Windows allows.',
    why: 'Windows restarts for updates outside this range only.',
    commands: [],
    expected: 'The page shows the range that you set.',
    errors: [
      err('You cannot find Active hours.', 'Open Settings, then Windows Update. Select Advanced options.'),
      err('Windows does not accept a longer range.', 'Windows has a maximum. Set the longest range that it accepts.'),
      err('Windows restarts at an unwanted time.', 'The range can reset after a large Windows update. Check the range again after each large update.'),
    ],
  },
  'install-wsl': {
    id: 'install-wsl', name: 'Install WSL', where: 'PowerShell as administrator',
    what: 'Install WSL without a distribution. Update it. Make version 2 the default. Restart Windows if the installer asks.',
    why: 'WSL runs the Linux system in which Docker runs.',
    commands: [{ shell: 'powershell', text: 'wsl --install --no-distribution\nwsl --update\nwsl --set-default-version 2' }],
    expected: '`wsl --version` prints a version.',
    errors: [
      err('PowerShell prints that `wsl` is not recognized.', 'Windows is too old. Do the step "Update Windows" again.'),
      err('The installer prints error 0x80370102.', 'CPU virtualization is off. Do the step "BIOS" again.'),
      err('The update cannot download.', 'Retry. Check the network, the VPN, and the proxy of the computer.'),
    ],
  },
  'install-ubuntu': {
    id: 'install-ubuntu', name: 'Install Ubuntu', where: 'PowerShell as administrator', fields: ['distro', 'user'],
    what: 'Install Ubuntu. Start it once. Create its Linux user. Use the distribution name from `wsl --list --verbose` as the distribution name below.',
    why: 'The factory runs as this Linux user. The distribution name is part of the boot task.',
    commands: [{ shell: 'powershell', text: 'wsl --install -d Ubuntu\nwsl --list --verbose' }],
    expected: '`wsl -l -v` shows `VERSION 2` for the distribution.',
    errors: [
      err('The name Ubuntu is not found.', 'Run `wsl --list --online`. Use a name from that list.'),
      err('The installation stays on "Installing".', 'Close the window. Run `wsl --list --verbose`. Start the distribution from the Start menu.'),
      err('The list shows `VERSION 1`.', 'Run `wsl --set-version <DISTRO> 2`.'),
    ],
  },
  systemd: {
    id: 'systemd', name: 'Turn on systemd', where: 'Ubuntu and PowerShell', h: ['H4'],
    what: 'Add a section to /etc/wsl.conf in Ubuntu. Keep its other sections. Stop the distribution. Start it again. Optional: mask systemd-binfmt.service.',
    why: 'Docker, SSH, and Tailscale start through systemd. The mask makes systemd report running.',
    commands: [
      { shell: 'file /etc/wsl.conf', text: '[boot]\nsystemd=true' },
      { shell: 'powershell', text: 'wsl --terminate <DISTRO>' },
      { shell: 'ubuntu', text: 'sudo systemctl mask systemd-binfmt.service\nsystemctl is-system-running\nsystemctl --failed --no-legend' },
    ],
    expected: '`systemctl is-system-running` shows `running`, or `degraded` with only `systemd-binfmt.service` failed. A failure of that unit alone does not prove a failure of Docker, SSH, or Tailscale.',
    errors: [
      err('The state is `offline`.', 'The file /etc/wsl.conf has no `[boot]` section. Fix it. Run `wsl --shutdown`. Open Ubuntu again.'),
      err('The state is `degraded` with other failed units.', 'Read each unit in the list. Fix it. Only `systemd-binfmt.service` is accepted as failed.'),
      err('The old content of wsl.conf is gone.', 'Add the section to the file. Do not replace the file.'),
    ],
  },
  'limit-memory': {
    id: 'limit-memory', name: 'Limit memory and CPU', where: 'Windows and Ubuntu', h: ['H1'], fields: ['memoryGb', 'cpuCount', 'swapGb'],
    what: 'Make the file `.wslconfig` in the Windows profile of the account that owns the distribution. Leave memory for Windows. Run `wsl --shutdown` to apply the file.',
    why: 'WSL takes all memory that Windows allows. The idle settings keep WSL running when you close the windows.',
    commands: [
      { shell: 'file %UserProfile%\\.wslconfig', text: '[wsl2]\nmemory=<MEMORY_GB>GB\nprocessors=<CPU_COUNT>\nswap=<SWAP_GB>GB\ninstanceIdleTimeout=-1\nvmIdleTimeout=-1\n\n[experimental]\nautoMemoryReclaim=gradual', own: true },
      { shell: 'powershell', text: 'wsl --shutdown' },
      { shell: 'ubuntu', text: 'free -h\nnproc' },
    ],
    expected: '`free -h` and `nproc` show the limits. Close all WSL windows. Wait 3 minutes. `wsl -l -v` still shows `Running` (H1).',
    errors: [
      err('The limits do not apply.', 'The file is in the wrong profile, or its name is `.wslconfig.txt`. Show file name extensions in Explorer.'),
      err('WSL does not start after the change.', 'The file has a typing error. Delete it. Make it again.'),
      err('Memory shows the old size.', 'WSL did not stop. Run `wsl --shutdown`. Open Ubuntu again.'),
    ],
  },
  'docker-repository': dockerRepository,
  'install-docker': installDocker,
  'configure-docker': configureDocker,
  'install-docker-unix': installDockerUnix,
  'configure-docker-unix': configureDockerUnix,
  'mac-tailscale': macTailscale,
  magicdns: magicDns,
  'access-policy': accessPolicy,
  'ubuntu-tailscale': {
    id: 'ubuntu-tailscale', name: 'Install Tailscale in Ubuntu', where: 'Ubuntu and Tailscale admin console', h: ['H5', 'H6'], fields: ['tailscaleAddress'],
    warning: 'Disable key expiry in the admin console. With key expiry on, the host leaves the tailnet when the key ends.',
    what: 'Install Tailscale inside Ubuntu. Sign in with your own account. Approve the tag. Select Disable key expiry. Give the factory user the operator right.',
    why: 'Tailscale inside Ubuntu gives the host its own name and address. The tag lets the access policy find it.',
    commands: [
      { shell: 'ubuntu', text: 'curl -fsSL https://tailscale.com/install.sh | sh\nsudo systemctl enable --now tailscaled\nsudo tailscale up --advertise-tags=tag:factory' },
      { shell: 'ubuntu', text: 'sudo tailscale set --operator=<FACTORY_USER>' },
      { shell: 'ubuntu', text: 'tailscale ip -4', own: true },
    ],
    expected: 'The admin console shows `tag:factory` and "expiry disabled" (H5). `tailscale serve status` prints "no serve config" without sudo (H6).',
    errors: [
      err('`tailscale up` waits and prints a web address.', 'Open the address in a browser. Sign in with your own account.'),
      err('`tailscale up` says the tags are not permitted.', 'The access policy has no tagOwners entry for tag:factory. Repeat the step "Write the access policy".'),
      err('`tailscale serve status` asks for sudo.', 'The operator right is missing. Run the `tailscale set --operator` command.'),
    ],
  },
  'ssh-key': sshKey,
  'public-key': publicKey,
  'ssh-server': sshServer,
  'ssh-order': sshOrder,
  'ssh-config': sshConfig,
  'boot-task': {
    id: 'boot-task', name: 'Create the boot task', where: 'Windows Task Scheduler', h: ['H2'], fields: ['windowsAccount'],
    warning: 'Enter the Windows account password only in the local Task Scheduler dialog. Never type it on this page. Do not use SYSTEM: the distribution belongs to your own account.',
    what: 'Make a task that starts WSL at startup and every 5 minutes. Run it as your own account, also when you are signed out.',
    why: 'WSL can stop without a Windows reboot. The repeating trigger starts it again.',
    list: [
      'Select Run whether user is logged on or not.',
      'Select Run with highest privileges.',
      'Add an At startup trigger. Add a second trigger that repeats every 5 minutes with no end date.',
      'Use C:\\Windows\\System32\\wsl.exe as the program.',
      'Use the arguments below as the arguments.',
      'Remove the task time limit. Permit a restart after a failure.',
      'Select Do not start a new instance when the task already runs.',
      'Enter the Windows account credential only in the local Task Scheduler dialog.',
    ],
    commands: [{ shell: 'arguments', text: '-d <DISTRO> -u root --exec /bin/sh -lc "systemctl start docker ssh tailscaled && exec /usr/bin/sleep infinity"' }],
    terminateTest: true,
    expected: 'Run the task by hand once. Then run the terminate-and-wait test below. The host answers again within 5 minutes.',
    errors: [
      err('The task ends after a short time.', 'The arguments differ from the text above. Copy them again. Check Last Run Result in Task Scheduler.'),
      err('The task does not run when you are signed out.', 'Select Run whether user is logged on or not. Save the Windows password in the dialog.'),
      err('The host does not return after `wsl --terminate`.', 'The repeating trigger is missing. Check that it repeats every 5 minutes with no end date.'),
    ],
  },
  test,
  'reboot-test': rebootTest,
  'machine-facts': machineFacts,
  answers,
};

const linuxOnly = {
  'linux-update': {
    id: 'linux-update', name: 'Update the system', where: 'Linux host', fields: ['user'],
    what: 'Update the packages of the Linux computer. Create or choose the Linux user for the factory.',
    why: 'A current system has the security fixes. The factory runs as this user.',
    commands: [{ shell: 'ubuntu', text: 'sudo apt-get update\nsudo apt-get upgrade -y', own: true }],
    expected: 'The commands end with no error. Type the user name in the field.',
    errors: [
      err('apt-get prints "Could not get lock".', 'Another update runs. Wait. Run the commands again.'),
      err('apt-get cannot reach the servers.', 'Check the network of the computer.'),
      err('The computer does not use apt.', 'These commands are for Ubuntu. Use the package tool of your distribution.'),
    ],
  },
  'linux-never-sleep': {
    id: 'linux-never-sleep', name: 'Never sleep', where: 'Linux host',
    what: 'Stop the computer from sleeping or hibernating.',
    why: 'A computer that sleeps cannot answer the Mac.',
    commands: [{ shell: 'ubuntu', text: 'sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target', own: true }],
    expected: '`systemctl status sleep.target` shows `masked`.',
    errors: [
      err('The command says the unit is not found.', 'The computer has no systemd. Use the power setting of your distribution.'),
      err('The screen lock still suspends the computer.', 'Turn off automatic suspend in the desktop power settings.'),
      err('The command asks for a password.', 'Use an account with sudo rights.'),
    ],
  },
  'linux-tailscale': {
    id: 'linux-tailscale', name: 'Install Tailscale on the host', where: 'Linux host and Tailscale admin console', h: ['H5', 'H6'], fields: ['tailscaleAddress'],
    warning: 'Disable key expiry in the admin console. With key expiry on, the host leaves the tailnet when the key ends.',
    what: 'Install Tailscale on the Linux computer. Sign in with your own account. Approve the tag. Select Disable key expiry.',
    why: 'Tailscale gives the host its own name and address. The tag lets the access policy find it.',
    commands: [
      { shell: 'ubuntu', text: 'curl -fsSL https://tailscale.com/install.sh | sh\nsudo systemctl enable --now tailscaled\nsudo tailscale up --advertise-tags=tag:factory' },
      { shell: 'ubuntu', text: 'sudo tailscale set --operator=<FACTORY_USER>' },
      { shell: 'ubuntu', text: 'tailscale ip -4', own: true },
    ],
    expected: 'The admin console shows `tag:factory` and "expiry disabled". `tailscale serve status` prints "no serve config" without sudo.',
    errors: [
      err('`tailscale up` waits and prints a web address.', 'Open the address in a browser. Sign in with your own account.'),
      err('`tailscale up` says the tags are not permitted.', 'The access policy has no tagOwners entry for tag:factory. Repeat the step "Write the access policy".'),
      err('`tailscale serve status` asks for sudo.', 'The operator right is missing. Run the `tailscale set --operator` command.'),
    ],
  },
};

const otherReboots = {
  'linux-reboot-test': otherReboot('linux-reboot-test', 'sudo reboot', 'Linux host and this page'),
  'mac-reboot-test': otherReboot('mac-reboot-test', 'sudo shutdown -r now', 'Host Mac and this page'),
};

const macOnly = {
  'orbstack-install': {
    id: 'orbstack-install', name: 'Install OrbStack', where: 'Host Mac', fields: ['user'],
    what: 'Install OrbStack on the host Mac. Start it once. Use the account that will run the factory.',
    why: 'OrbStack runs Docker on a Mac. The factory runs in a container.',
    commands: [{ shell: 'mac', text: 'orbctl version', own: true }],
    expected: 'The command prints the OrbStack version. Type the Mac user name in the field.',
    errors: [
      err('`orbctl` is not found.', 'Start the OrbStack app once. It adds the command line tools.'),
      err('OrbStack asks for a license.', 'Choose the license that fits your use. This guide cannot choose for you.'),
      err('Docker does not start.', 'Open the OrbStack app. Read its status message.'),
    ],
  },
  'orbstack-memory': {
    id: 'orbstack-memory', name: 'Limit OrbStack memory', where: 'Host Mac', fields: ['memoryGb'],
    what: 'Set the memory limit of OrbStack to 4 GB. Start one factory at a time.',
    why: 'A factory and the work of the Mac share the same memory.',
    commands: [{ shell: 'mac', text: 'orbctl config set memory_mib 4096\norbctl stop\norbctl start', own: true }],
    expected: 'Type 4 in the memory field. `docker info --format \'{{.MemTotal}}\'` shows about 4 GB.',
    errors: [
      err('The command says the setting is unknown.', 'Open the OrbStack settings in the app. Set the memory limit to 4 GB there.'),
      err('Docker shows more memory.', 'OrbStack did not restart. Run `orbctl stop` and `orbctl start`.'),
      err('The factory runs out of memory.', 'Stop other factories on this Mac. Run one factory at a time.'),
    ],
  },
  'host-mac-tailscale': {
    id: 'host-mac-tailscale', name: 'Put the host Mac on Tailscale', where: 'Host Mac', h: ['H5'], fields: ['tailscaleAddress'],
    warning: 'Disable key expiry in the admin console. With key expiry on, the host leaves the tailnet when the key ends.',
    what: 'Install Tailscale on the host Mac. Sign in with your own account. Give the machine the tag tag:factory. Select Disable key expiry.',
    why: 'The host Mac needs a private name and address. The tag lets the access policy find it.',
    commands: [{ shell: 'mac', text: 'tailscale ip -4', own: true }],
    expected: 'The admin console shows `tag:factory` and "expiry disabled". The command prints the address. Type it in the field.',
    errors: [
      err('The Mac prints "command not found: tailscale".', 'Run `/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4`.'),
      err('The tag is not permitted.', 'The access policy has no tagOwners entry for tag:factory. Repeat the step "Write the access policy".'),
      err('The address does not show.', 'Open the Tailscale menu. Turn Tailscale on.'),
    ],
  },
  'host-mac-ssh': {
    id: 'host-mac-ssh', name: 'Turn on Remote Login and add the key', where: 'Host Mac',
    warning: 'Remote Login lets other computers sign in to this Mac. Turn it on only when the access policy is in place.',
    what: 'Open System Settings, then General, then Sharing. Turn on Remote Login. Add the public key to authorized_keys of the factory user.',
    why: 'The Mac controls the host over SSH. The host accepts the key and nothing else.',
    commands: [{ shell: 'mac', text: 'install -d -m 700 ~/.ssh\nnano ~/.ssh/authorized_keys\nchmod 600 ~/.ssh/authorized_keys', own: true }],
    expected: 'Remote Login shows On. The public key is one line in the file.',
    errors: [
      err('Remote Login cannot turn on.', 'Ask the owner of the Mac. Only an administrator can turn it on.'),
      err('Login fails with "Permission denied (publickey)".', 'The folder must be mode 700 and the file mode 600. Both belong to the factory user.'),
      err('Password login still works.', 'Set PasswordAuthentication to no in a file in /etc/ssh/sshd_config.d. Turn Remote Login off and on.'),
    ],
  },
};

const pick = (source, ids) => ids.map((id) => source[id]);
const MERGED = { ...windowsOnly, ...linuxOnly, ...macOnly, ...otherReboots };

// The step objects of each host type, in order.
export const STEPS = Object.fromEntries(HOST_TYPES.map((type) => [type.id, pick(MERGED, type.steps)]));
