# Herdr Boss factories

The language of Herdr Boss factories: how the Owner runs, reaches, and supervises several Herdr Boss installations. For the plain words of the user docs, read the [glossary](glossary.md). The design is in [ideas/factories.md](ideas/factories.md). The decisions are in [adr/](adr/index.md).

## Language

### Factories and hosts

**Factory**:
One Herdr server, one Herdr Boss service, and their data, projects, harnesses, and browser, in one process namespace.
_Avoid_: instance, node, site

**Factory zero**:
The factory that runs natively on the Owner's Mac, outside a container.
_Avoid_: native factory, the Mac factory, local Boss

**Container factory**:
A factory that runs in one container made from the factory image.
_Avoid_: docker factory, managed factory

**Personal factory**:
A factory that does only the Owner's own, non-commercial work. It uses the Owner's subscriptions.
_Avoid_: experiments factory, private factory, own factory

**Client factory**:
A factory that does commercial work for one client. It can run on the Owner's host or on the client's own compute. It uses accounts that are separate from the Owner's subscriptions.
_Avoid_: customer factory, tenant factory

**Client-premises factory**:
A client factory that runs on compute that the client owns and controls.
_Avoid_: on-prem factory, remote factory

**Host**:
A machine that runs one or more factories.
_Avoid_: server, box, node

**Transport**:
The way the host tool reaches the container runtime of a host: `local`, `ssh`, `portainer`, or `agent`.
_Avoid_: connector, driver

**Factory Boss**:
The Boss agent of one factory. It supervises the orchestrators of that factory.
_Avoid_: local Boss, sub-Boss

**Fleet**:
All factories that one Owner manages.
_Avoid_: cluster, estate

### Accounts and quota

**Account scope**:
The factories that may use one harness account or subscription.
_Avoid_: account binding, account lock

**Shared account**:
A harness account or subscription whose account scope holds two or more factories. Its quota is one pool for all of them.
_Avoid_: common login, pooled account

**Factory share**:
The percentage of one shared account's quota that one factory may use.
_Avoid_: allocation, factory ceiling, factory quota

**Guidance**:
Factory shares and nudge messages that the head office sends to the Boss of a factory.
_Avoid_: instructions, commands, policy push

### Tools and artifacts

**Host tool**:
The `herdr-boss factory` command. It runs on a host, outside every container.
_Avoid_: factory CLI, herdr-factory

**Factory image**:
The container image from which every container factory starts. It holds tools and a seed checkout, and no data and no secret.
_Avoid_: base image, factory template

**Profile**:
A named template for a factory: policy seed, models, required wizard steps, and naming.
_Avoid_: preset, flavour, template

**Wizard**:
The resumable sequence of checked steps that `factory configure` runs to make a factory ready.
_Avoid_: setup script, installer

### Head office and succession

**Head office**:
The role of the one factory that reads the summaries of all factories and holds the fleet records. Any eligible factory can hold the role.
_Avoid_: hub, master, control plane

**Standby**:
A factory that receives head office snapshots and can take the head office role.
_Avoid_: replica, secondary, backup head office

**Succession list**:
The Owner-signed, ranked list of factories that may hold the head office role.
_Avoid_: failover list, priority list

**Epoch**:
The number of a head office term. Each new holder of the role uses the last epoch plus one.
_Avoid_: term, generation, version

**Anchor key**:
The Owner's offline signing key. It signs the succession list and authorizes a head office move.
_Avoid_: root key, master key

**Fleet summary**:
The small, allow-listed document that a factory serves to the head office.
_Avoid_: fleet state, status feed

### Work movement

**Transfer**:
The planned move of one project from a source factory to a target factory, with a freeze and an Owner confirmation.
_Avoid_: migration, move, handover

**Handover**:
The replacement of one orchestrator pane by a fresh orchestrator pane for the same project in the same factory.
_Avoid_: transfer, handoff

## Relationships

- A **Host** runs one or more **Factories**. **Factory zero** is the only factory that is not a **Container factory**.
- The **Head office** is a role that one **Factory** holds in one **Epoch**. It reads one **Fleet summary** from each factory.
- A **Standby** is on the **Succession list**. A **Client-premises factory** is never a **Standby**.
- The **Head office** sends **Guidance** to each **Factory Boss**. Each **Factory** enforces its own **Factory share** of each **Shared account** in its **Account scope**.
- A **Transfer** moves a project between two **Factories**. A **Handover** stays inside one **Factory**.
