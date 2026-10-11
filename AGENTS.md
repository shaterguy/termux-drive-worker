# Drive Worker development authority
- GitHub private repository `shaterguy/termux-drive-worker` is the source and version history authority.
- GitHub `main` and the verified release tag define canonical source; deployed release dirs are immutable derived artifacts.
- Make changes in a Git checkout, run `node --check worker.mjs` and `node --test worker.regression.test.mjs`.
- Confirm source SHA, remote commit SHA and BOTH hosts' runtime state before marking a release delivered.
- Do not commit live credentials, tokens, auth files, runtime state, or worker command/result data.
- Keep automatic runtime cleanup disabled unless explicitly requested.
- Preserve ACTIVE/STANDBY arbitration, command/result JSON compatibility, and exit/replay safety.
- Treat archived Drive copies as reference artifacts, not an alternate source of truth.
