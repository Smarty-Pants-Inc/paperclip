# Tailscale image read — names only

Scope: source read only at merge baseline `259a58e5485253a0b13769ca0ed681462354172f` (unchanged by this task). No image build, daemon start, sign-in, secret lookup, environment-value inspection or credential use.

## Installed programs and source

- Server `Dockerfile:15–31`: separate `tailscale-client` stage downloads **Tailscale 1.104.5** from **`https://pkgs.tailscale.com/stable/tailscale_1.104.5_${TARGETARCH}.tgz`**. Supported architectures: `amd64`, `arm64`; any other architecture fails the build. HTTPS-only redirects and per-architecture SHA-256 verification precede extraction. The hashes are public artifact-integrity digests, not credentials.
- `Dockerfile:390–392`: copies **`tailscale`** and **`tailscaled`** into **`/usr/local/bin/`** in the server production image, plus the checked-in vendor license into **`/usr/local/share/licenses/tailscale/LICENSE`**. Build-time execution is version checks only. Cloud inherits this production image.
- Source: [Dockerfile](https://github.com/Smarty-Pants-Inc/paperclip/blob/259a58e5485253a0b13769ca0ed681462354172f/Dockerfile#L15-L31), [production copies](https://github.com/Smarty-Pants-Inc/paperclip/blob/259a58e5485253a0b13769ca0ed681462354172f/Dockerfile#L390-L392). Local evidence: `logs/tailscale-image.patch`.

## Credential/auth-key baked in: NONE

The Tailscale stage has only the architecture build argument; the download is a public HTTPS artifact with no authentication header. Neither this stage, its production COPY/version checks, nor the image's runtime ENV stanza supplies an enrollment credential, auth key, OAuth credential, or node state. `scripts/docker-entrypoint.sh` does not start or enroll Tailscale. Installing the programs is not joining a tailnet. This is a source audit of the Tailscale install, not an assertion about arbitrary operator-supplied build context or a built image's layers.

## Runtime opt-in and environment names

**There is no Tailscale enable/auth-key environment variable required by this connector.** Normal enablement is explicit runtime device sign-in: **Connectors → Tailscale → Connect Tailscale Network**, consent, then choosing that connection/machine in an SSH environment. New sign-ins need no Cloud broker or auth key. The daemon starts for the requested connection, not merely because the binary exists.

The new connector reads these optional **program-path overrides**, not enable switches or credentials:

| Environment name | Purpose |
| --- | --- |
| `PAPERCLIP_TAILSCALE_CLI` | Select the `tailscale` executable; default is its PATH name. Also used by device discovery. |
| `PAPERCLIP_TAILSCALED` | Select the `tailscaled` executable; default is its PATH name. |

`server/src/services/connectors/tailscale/network.ts:141–146` starts a private userspace daemon; its CLI requests disable DNS/subnet-route acceptance and shield incoming traffic. Device consent and saved connector state are runtime-only, company-scoped vault data; no values were read here.

Related existing names, **not connector enable switches**: `PAPERCLIP_TAILNET_BIND_HOST` (server bind-address override), `PAPERCLIP_TAILSCALE_DNS_NAME` (runtime-exposure hostname override), `PAPERCLIP_TAILSCALE_BROKER_SOCKET` (workspace HTTPS broker socket), and `PAPERCLIP_SECRETS_MASTER_KEY` (existing vault custody, not Tailscale enrollment). No `TS_AUTHKEY`/`TS_*` enrollment environment is read by this image install/entrypoint or the connector network manager.

The legacy OAuth callback remains for previously started pilot flows; the names-only runtime connector configuration there is `PAPERCLIP_CLOUD_CONNECTOR_{INSTANCE_ID,SIGN_PRIVATE_KEY,SEAL_PRIVATE_KEY,ENVIRONMENT,BASE_URL}` (or the legacy `PAPERCLIP_ID_CONNECTOR_*` family). These are **not required or read for normal device sign-in** and none are added to the image by the Tailscale stage. No values were inspected.

Authoritative existing feature: [doc/tailscale-environments.md:9–24](https://github.com/Smarty-Pants-Inc/paperclip/blob/259a58e5485253a0b13769ca0ed681462354172f/doc/tailscale-environments.md#L9-L24) documents runtime opt-in; lines 91–93 separate the old OAuth path; lines 182–184 document the two executable overrides. This task uses that documented feature and adds no seam/plugin/core feature. Source-name receipt: `logs/tailscale-env-names.txt`.
