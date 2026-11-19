# Gateway tools

Tools the gateway serves itself, next to the tools of a brain's `engram mcp`
child (`src/gateway-tools`). The first one is `brain_health` (#18); brain and
connection tools (#12, #27) build on the same mechanism.

## How a gateway tool runs

- **tools/list:** engram's tools first, then the gateway tools
  (`mergeToolLists`). A gateway tool shadows an engram tool of the same name,
  so the list matches where calls go. The list is then filtered by the
  caller's role, as before.
- **tools/call:** the bridge runs the one tool-call pipeline
  (authorize -> drop host paths -> redact -> forward -> audit -> wrap). For a gateway tool the
  forward step calls the tool's handler instead of engram; every other stage
  is unchanged, so gateway tools are authorized, audited and wrapped as data
  like engram's.
- **Roles:** each gateway tool needs an entry in `GATEWAY_TOOL_ROLES`
  (`src/authz/domain/tool-roles.ts`). `TOOL_ROLES` stays the exact table of
  engram's tools, which `scripts/check-bridge.mjs` compares with the live
  engram binary.
- **Startup check:** `createGatewayToolSet(tools, { engram: TOOL_ROLES,
  gateway: GATEWAY_TOOL_ROLES })` throws when a gateway tool has an engram
  tool's name (it would shadow it and take over its role) or has no role (with
  auth off the allow-all pipeline would run it unchecked).
- **Context:** the handler gets `{ brain, caller? }`; `caller` holds `login`,
  `clientId` and the effective `role` the authorize stage decided (absent with
  auth off). Tools act on behalf of that caller instead of looking it up
  around the pipeline.
- **Connections on `/mcp` (#27):** the connection server
  (`src/bridge/connection-server.ts`) serves the same gateway tools with the
  same pipeline. They get the `brain` argument like engram's tools, `brain`
  in the context is the brain the call was routed to, `caller.connectionId`
  is set, and `role` is the weaker of the user's grant and the connection's
  role.
- **`brain_resolve` (#12):** `src/gateway-tools/tools/brain-resolve.ts`, role
  `reader`. Maps a git remote to a brain with the `BRAIN_REMOTES` rules
  (`src/gateway-tools/application/remote-mapping.ts`: `normalizeRemote`,
  `parseRemoteMapping`, `matchRemote`), answering only with a brain the
  caller can use: on a connection, its brains with a non-null effective role
  (the `ConnectionAdmin.describe` view `brain_list` shows); else the call's
  brain. Fails open to the default brain or `null`, never a tool error.
- **Connection tools (#27):** `brain_list`, `connection_brains`,
  `connection_attach` and `connection_detach` (`src/gateway-tools/tools/connection-tools.ts`)
  are a second tool set served only by the connection server. They act on the
  caller's connection (`caller.connectionId`), not on a brain, so they have no
  brain role: `CONNECTION_TOOL_KINDS` (`src/authz`) lists the connection kinds
  that may call each, and `ConnectionAdmin.check` (`src/connections`) replaces
  the authorize stage for them (kind; for attach and detach, the owner role on
  the connection, i.e. `owner` on one of its brains still granted to the
  owner; for attach, the owner's grant). The audited brain is `null` when the
  argument is not a valid brain name, and an attach row records the role
  asked for (`meta.role`, one of `reader`, `writer`, `owner`).
  The other stages run as usual; the audited brain is the one the call acts
  on.

## Adding a tool

1. Implement `GatewayTool` (`definition` + `call(args, { brain, caller })`) under
   `src/gateway-tools/tools/`. Return tool errors as `toolError(message)`;
   throw only for unexpected failures.
2. Give it a role in `GATEWAY_TOOL_ROLES`.
3. Add it to the `createGatewayToolSet([...])` call in `src/main.ts`.
