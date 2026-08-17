import { createBinding } from './binding.js';

// THE PLUGIN ENTRY, and nothing else. opencode's classic plugin loader imports this file and treats
// EVERY export as a plugin function -- it iterates `Object.values(mod)` and rejects the whole file
// with "Plugin export is not a function" if any export is not callable (plugin/index.ts:95-106). So
// this module exports ONE thing, the plugin function; createBinding, LEVEL_EVENTS, and everything
// testable live in binding.js, out of the loader's reach. No `default` alias -- the loader takes the
// named export, and a second export of the same function is just a double-registration footgun.
//
// A server plugin is an async function that receives the opencode context and returns a hooks
// object. `directory` is the project cwd; the three hooks are the whole of familiar's contract with
// opencode -- the session event stream, the permission ask, and teardown.
export const Familiar = async ({ directory } = {}) => {
  const binding = createBinding({ directory });
  return {
    event: async (input) => binding.onEvent(input),
    'permission.ask': async (permission) => binding.onPermissionAsk(permission),
    dispose: async () => binding.dispose(),
  };
};
