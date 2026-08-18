import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Every path is env-overridable so tests can run against a temp dir without
// touching the developer's real state.
export function paths(env = process.env) {
  const home = env.HOME ?? homedir();
  const configDir = env.FAMILIAR_CONFIG_DIR ?? join(home, '.config', 'familiar');
  const stateDir = env.FAMILIAR_STATE_DIR ?? join(home, '.local', 'state', 'familiar');

  return {
    configDir,
    stateDir,
    configPath: join(configDir, 'config.yaml'),
    schemePath: join(configDir, 'scheme.json'),
    identitiesPath: join(configDir, 'identities.yaml'),
    userThemesDir: join(configDir, 'themes'),
    themeReceiptsDir: join(configDir, 'theme-receipts'),
    themesDir: env.FAMILIAR_THEMES_DIR ?? join(REPO_ROOT, 'themes'),
    agentsPath: join(stateDir, 'agents.json'),
    lockPath: join(stateDir, 'agents.lock'),
    intentPath: join(stateDir, 'intent.json'),
  };
}
