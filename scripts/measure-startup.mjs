// Measures where a production server container's startup time goes.
//   node scripts/measure-startup.mjs [runs]
// Needs the production stack running (docker-compose.prod.yml with .env.prod).
// Recreates the server container `runs` times and prints, per run (ms from `docker compose up`):
//   started   - Docker has started the container process
//   listening - the server logged "Server listening" (process boot + config + migrations + listen)
//   phases    - the server's own startup breakdown, if it logs one ("startup complete")
//   healthy   - Docker marked the container healthy (depends on the health-check schedule)
import { execFileSync } from 'node:child_process';

const COMPOSE = ['compose', '-f', 'docker-compose.prod.yml', '--env-file', '.env.prod'];
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const runs = Number(process.argv[2] ?? 3);

for (let run = 1; run <= runs; run++) {
  const t0 = Date.now();
  docker(...COMPOSE, 'up', '-d', '--force-recreate', '--no-deps', 'server');
  // The stack runs two server replicas; both are recreated, the first is measured.
  const id = docker(...COMPOSE, 'ps', '-q', 'server').split(/\r?\n/)[0] ?? '';
  let healthyAt = 0;
  while (Date.now() - t0 < 120_000) {
    const status = docker('inspect', id, '--format', '{{.State.Health.Status}}');
    if (status === 'healthy') {
      healthyAt = Date.now();
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const startedAt = Date.parse(docker('inspect', id, '--format', '{{.State.StartedAt}}'));
  const lines = docker('logs', id)
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));
  const listening = lines.find((l) => String(l.msg).startsWith('Server listening'));
  const phases = lines.find((l) => l.msg === 'startup complete');
  const rel = (t) => (t ? `${t - t0} ms` : 'n/a');
  console.log(
    JSON.stringify({
      run,
      started: rel(startedAt),
      listening: rel(listening?.time),
      phases: phases?.phases ?? null,
      healthy: rel(healthyAt),
    }),
  );
}
