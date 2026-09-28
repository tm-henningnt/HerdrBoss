# Orchestrator handover

Read this file when your harness quota threatens the orchestrator.

1. Run `herdr-boss ledger check --runs` to find run records with no ledger entry.
2. Add a ledger entry for each run that has none.
3. Run `herdr-boss handoff plan <your-pane> --to <kind>`.
4. Use `handoff prepare` to start a successor.
5. Review its output before `handoff activate <id> --confirmed`.

- Check your project on the Boss dashboard or in `herdr-boss policy show` when handover changes. Apply the saved succession ladder.
