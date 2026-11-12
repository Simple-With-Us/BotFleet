// An explicit entrypoint for reviewed retained source proof, never a host service.
import { writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLinuxClosureFixture, linuxFixturePlan } from './retained-fixture.mjs';
import { materializeOfflineLfs } from '../../scripts/linux-retained-checkout.mjs';
import { createActualLinuxAdapters } from './retained-actual-adapters.mjs';

function summary(result) {
  return {
    executed: result.executed,
    proof: result.proof ?? result.plan?.proof,
    candidateHealthy: result.candidateHealthy ?? false,
    rollbackHealthy: result.rollbackHealthy ?? false,
    cleanupFailures: result.cleanupFailures ?? [],
    preservation: result.preservation,
    trace: result.trace ?? [],
  };
}

export async function runActualProof({ execute = false, repo, currentPath, priorPath, output, node, pnpm }) {
  const candidate = JSON.parse(readFileSync(currentPath, 'utf8'));
  const prior = JSON.parse(readFileSync(priorPath, 'utf8'));
  const plan = linuxFixturePlan(candidate, prior, 'filtered-git');
  const root = resolve(output);
  if (!execute) return {
    executed: false, proof: plan.proof, preservation: 'not-established',
    current: { sourceSha: plan.candidate.sourceSha, files: plan.candidate.files.length },
    prior: { sourceSha: plan.prior.sourceSha, files: plan.prior.files.length },
    phases: plan.phases,
  };
  const adapters = createActualLinuxAdapters({ root, node, pnpm });
  const result = await runLinuxClosureFixture({
    repo, candidate, prior, output: root, execute: true, adapters,
    materialization: 'filtered-git', materializeLfs: materializeOfflineLfs, preparedRoot: true,
  });
  const receipt = summary(result);
  writeFileSync(join(root, 'actual-source-runtime-result.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx', mode: 0o600,
  });
  return receipt;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 9 || !['--plan', '--execute'].includes(process.argv[2])) {
    console.error('usage: retained-actual-run.mjs (--plan|--execute) <source-cache> <current-receipt> <prior-receipt> <output> <node> <pnpm>');
    process.exitCode = 2;
  } else {
    const [, , mode, repo, currentPath, priorPath, output, node, pnpm] = process.argv;
    try {
      const result = await runActualProof({ execute: mode === '--execute', repo, currentPath, priorPath, output, node, pnpm });
      console.log(JSON.stringify(result));
      if (result.executed && (!result.candidateHealthy || !result.rollbackHealthy || result.cleanupFailures.length)) process.exitCode = 1;
    } catch (error) {
      console.error(`Actual retained source fixture refused: ${String(error)}`);
      process.exitCode = 1;
    }
  }
}
