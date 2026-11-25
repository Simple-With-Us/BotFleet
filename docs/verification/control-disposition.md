# Control Disposition

The decommission gate requires a `control-disposition` receipt before `mac-control/` may be retired with Electron (BF-2485). The bundle defines it as three checks, `owner-decision`, `landed-implementation` and `muster-disposition`, and accepts a receipt only when every one of them exits zero.

The three are not alike.  Two are facts about a commit, and one is a person's word about where the fleet administration went.  So the producer is two scripts, and neither takes an exit code from the operator for the part it can measure.

## What Each Check Holds

**`owner-decision`** holds when the ruling that split BotFleet Control is in the tree: `docs/plans/2026-10-29-botfleet-control-after-node.md` carries both the option's name and the Zulip message the ruling was relayed as.  The name alone also appears in the list of options the document offers, so it cannot by itself tell the ruling from the question.

**`landed-implementation`** holds when every control the ruling moved into the native app is in the tree, each with every requirement it needs:

| Control | What the tree has to carry |
| --- | --- |
| Harness status | the control route in `CompanionCore`, and the status in `MacApp` |
| Fenced stop | the fenced stop route in `CompanionCore`, and the app's shutdown action |
| Fenced start | the `kickstart` in `CompanionCore`, and the app's call into it |
| Start Server At Login | the policy marker in `CompanionCore`, and the app's call into it |
| Shared Local VM | both VM routes in `CompanionCore`, and the app's stop action |
| Saved servers | the host record in `CompanionCore`, and the app's servers settings |
| Saved servers import | Control's saved-server file named in `CompanionCore` |
| Lifecycle section | the section's view in `MacApp` |

A control with two halves needs both, because a client nothing calls is not a control.  Needles are matched as substrings, under a path prefix.

**`muster-disposition`** holds when the acceptance owner attests, for each of the four things the ruling moved out of the product, where it went and an https record of that:

- the twelve-row fleet services list;
- the pm2 rows;
- the process and port monitor with orphan kill;
- the remote VM providers.

The attestation has to be the bundle's acceptance owner's.  The producer cannot establish that the person wrote it: it reads a saved file, the same line every other producer holds.

## Recipe

From a seat lane, with the candidate's commit in any local repository:

```sh
node scripts/check-control-disposition.mjs \
  --source "$FLEET_CODE_ROOT/BotFleet" --commit <candidate sourceSha> \
  --out /private/captures/control-disposition.verdict.json

node scripts/emit-control-disposition-receipt.mjs \
  --capture /private/captures/capture --request /private/captures/bundle-request.json \
  --verdict /private/captures/control-disposition.verdict.json \
  --attestation /private/captures/muster-attestation.json \
  --provenance-record provenance.txt --provenance-source <https-url> \
  --provenance-by "<who>" --provenance-at <ISO-8601-instant>
```

The attestation file holds one entry per item, and names the bundle request's `acceptanceOwner`:

```json
{
  "version": 1,
  "decision": "<the attestation, in the owner's words>",
  "items": [
    { "id": "fleet-services-list", "disposition": "<where it went>", "evidence": "https://<record>" },
    { "id": "pm2-rows", "disposition": "<where it went>", "evidence": "https://<record>" },
    { "id": "process-and-port-monitor", "disposition": "<where it went>", "evidence": "https://<record>" },
    { "id": "remote-vm-providers", "disposition": "<where it went>", "evidence": "https://<record>" }
  ],
  "attestedBy": "<acceptanceOwner>",
  "attestedAt": "<ISO 8601 instant>",
  "source": "https://<the record of the attestation>"
}
```

The check exits 0 when both measured checks hold and 1 when either does not, and prints the verdict either way.  The emitter writes `control-disposition.receipt.json` and the three artifacts it cites into the capture directory, owner-only, and exits 2 with the reason when it refuses.  It refuses a verdict taken against another commit than the bundle's candidate, one whose summary does not follow from its own details, one that leaves a control out, an attestation that is silent about an item or by anyone but the acceptance owner, and anything that holds an unredacted credential.  Nothing is written on a refusal, and a receipt from an earlier good run stays as it was.

## What The Tests Prove

`scripts/emit-control-disposition-receipt.node-test.mjs` proves the check against temporary repositories, the emitter's refusals, and that the gate's own validator accepts an emitted receipt and refuses one with a changed exit code or a changed artifact byte.  The command line of each script is run as a caller runs it.

The tests prove the producer.  They do not prove the controls work: a marker says the code is there, and whether it starts a server or stops one is what the tests under `ios/` and the installed-route check (BF-2527) say.

## Where It Stands

Measured on main at `43e8333168`, Nov 24: `owner-decision` holds.  `landed-implementation` does not.  Six of the eight controls are there, and the fenced start and the saved servers import are not (BF-2700, BF-2702). No attestation of the Muster disposition is recorded.  No receipt can be produced until both change, and the producer says so rather than writing one.
