// The environment of a reader child. A reader child gets only these variables from this process, so no token in the service environment reaches it.
// HOME and CODEX_HOME stay so that the harness finds its own login. Herdr Boss reads no login file.
const ALLOWED = ['PATH', 'HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'LANG', 'TERM'];

export function readerChildEnv(extra = {}, source = process.env) {
  const env = {};
  for (const key of ALLOWED) if (typeof source[key] === 'string') env[key] = source[key];
  return { ...env, ...extra };
}
