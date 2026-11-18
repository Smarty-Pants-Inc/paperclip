# Pi reopen replay fixture

`pi-reopen-agent-home.json` is a minimized, anonymized projection of the
post-refusal provider checkpoint from a cold-reopen incident. It is not claimed
to be a pre-refusal checkpoint: the available earlier epoch is a control-plane journal,
not provider state.

The predicate needs only an idle saved Pi thread, a different run, a revised
completion contract, and different composed instructions. In this incident the
instruction asset was unchanged; its composed AGENT_HOME path included the run
ID. The fixture replaces the whole instruction with a synthetic path and retains
no production prompt, instruction body, tool input/result, credential, or ID.
Launch paths, cwd, the attested launch digest, and the compiled Pi profile are
bound to the test environment before the bytes are loaded by the executor.

The regression fails with the generic provider/contract-change refusal on the
installed `1630490cc` clause. It already passes on `2735d4caf`: the Pi stable-config
comparison added by `b80c87cd1` admits only the run-scoped instruction change after
settlement. This replay adds coverage, not another runtime admission exception.
