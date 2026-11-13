# Adopt SSH for guardian calls

The problem is **secret zero**, followed by a **forced command used as unary RPC**.
The worker already trusts the authenticated Boat API. It must introduce a public
SSH identity, pin the guest host key from that API, then carry one guardian
request and reply without putting tickets in provider command records or files.

| Option | Fit | Cost |
| --- | --- | --- |
| OpenSSH forced command | Direct stdin, EOF, stdout and exit status. Host authentication and encryption cover the whole stream. Multiplexing amortizes the handshake. | An owned agent and per-lease control socket. Public-key registration and retirement. |
| TLS inside a WSS relay | Could protect the stream beyond Boat's TLS proxy. | A relay, TLS bootstrap and lifecycle code that SSH already supplies. |
| Boat exec | Good for public bootstrap and image checks. | The documented commands path is not a private live stdin stream. Staging tickets in command text or uploaded files is not acceptable. |

**Decision: use OpenSSH.** This follows cluster-lead's decision after the
[transport challenge](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20176#issuecomment-6819220966).
There is no new relay, custom MAC, guest port or guest process-ownership record.
The existing server image already installs `openssh-client` (`Dockerfile:191`).
No npm runtime dependency is added. `ssh2` also exists in the repository lockfile,
but adding another client is unnecessary.

The worker generates an ed25519 identity in memory. It adds that identity over
the socket of an OpenSSH agent it owns. No private-key file or key-bearing argv
is used. The Boat API receives only the public key. The worker then changes that
key's authorized line to `restrict,command="..."`, before opening any SSH session.

SSH protects authentication, confidentiality and integrity from the worker to
the guest sshd, through Boat's TCP proxy. The host key comes only from Boat's
HTTPS API, never from TOFU or `ssh-keyscan`. A mismatch permits one API refresh,
not acceptance of the connection's offered key.

SSH does **not** isolate the guardian from Pi running as the same UID or with
sudo. Such a process can alter authorized keys or access the guardian socket.
The accepted transport work does not settle
[#20192](https://github.com/Smarty-Pants-Inc/smarty-dev/issues/20192).
It also does not preserve a claim ticket through worker memory loss. Exact retry
requires the same request and ticket; a lost ticket is not permission to invent a
new claim or cold replacement.

References: [Boat SSH](https://docs.boat.dev/ssh-access),
[SSH key API](https://docs.boat.dev/api/reference/agent/configure-sandbox-ssh-key),
[OpenSSH authorized keys](https://man.openbsd.org/sshd.8#AUTHORIZED_KEYS_FILE_FORMAT),
[OpenSSH multiplexing](https://man.openbsd.org/ssh_config.5#ControlMaster).

Route A uses S9's existing per-lease marker and live qualification gate, with
static duplex support as authorized by the lead's ruling. [SSH.md](SSH.md)
records the separate generic-bridge install precondition and typed fallback.
Passing local transport tests is not live Boat acceptance.
