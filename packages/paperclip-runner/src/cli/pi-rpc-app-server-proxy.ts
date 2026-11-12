#!/usr/bin/env node
// Native OpenCode's protected facade is the integration template. This stub
// MUST fail before initialize/thread/start until code-lead installs the Pi
// HarnessSession-to-facade translator. It never advertises executable support.
process.stderr.write("pi_rpc_proxy_not_integrated: native Pi HarnessSession facade body is required\n");
process.exitCode = 78;
