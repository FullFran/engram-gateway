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
  (`src/authz/domain/tool-roles.ts`), or it is denied for every role.
  `TOOL_ROLES` stays the exact table of engram's tools, which
  `scripts/check-bridge.mjs` compares with the live engram binary.

## Adding a tool

1. Implement `GatewayTool` (`definition` + `call(args, { brain })`) under
   `src/gateway-tools/tools/`. Return tool errors as `toolError(message)`;
   throw only for unexpected failures.
2. Give it a role in `GATEWAY_TOOL_ROLES`.
3. Add it to the `createGatewayToolSet([...])` call in `src/main.ts`.
