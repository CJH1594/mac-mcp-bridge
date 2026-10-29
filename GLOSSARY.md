# Remote development access

This context covers approval of remote MCP connections and the host work performed through them.

## Language

**Connection approval**:
The local operator's consent to a particular MCP client's connection request and its requested resource and callback.
_Avoid_: Automatic login, token refresh

**Approval request number**:
A reference that lets the local operator identify and inspect a pending connection request. Knowing the number alone does not grant access.
_Avoid_: Password, access token

**Approved session**:
The period of access granted by a connection approval, with a deadline that token refresh and ordinary restarts do not extend. Only an explicit local time reset changes the deadline of an unexpired approval.
_Avoid_: Process session

**Disconnect**:
Revoking the approved connection and ending managed work, then allowing a new connection approval after cleanup succeeds. The terminal `stop` command performs this action.
_Avoid_: Normal close

**Local time reset**:
The operator's explicit `reset time` command, setting an unexpired approved session's deadline to six hours from now. This preserves its identity and does not approve a second connection.
_Avoid_: Automatic refresh

**Normal close**:
Ending the running instance and its managed work while preserving connection approvals and client registrations for a later start.
_Avoid_: Emergency stop, revocation

**Emergency stop**:
The operator's explicit withdrawal of connection approvals, blocking further access and ending managed work. A temporary loss of connectivity is not an emergency stop.
_Avoid_: Normal close, tunnel interruption

**Managed work**:
Host execution whose lifetime is owned by the server, including commands, scripts, and patch execution.
_Avoid_: Independent OS service

**Process session**:
The identity and retained results of one managed host process, which may outlive the request that started it.
_Avoid_: Approved session, OAuth session
