const DEFAULT_SERVER_URL_CONFIG = 'https://raw.githubusercontent.com/vikas-bhat-d/watchsync/main/serverurl.txt';
const SERVER_URL_CONFIG_TIMEOUT_MS = 4000;

function readCommandLineServerUrl(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith('--server-url=')) {
      const value = argument.slice('--server-url='.length).trim();
      if (!value) throw new Error('Provide a URL after --server-url.');
      return value;
    }

    if (argument === '--server-url') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Provide a URL after --server-url.');
      }
      return value.trim();
    }
  }

  return null;
}

function validateServerUrl(value, source) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${source} must be a valid HTTP or HTTPS URL.`);
  }

  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error(`${source} must be a valid HTTP or HTTPS URL.`);
  }
  if (url.username || url.password) {
    throw new Error(`${source} must not contain credentials.`);
  }

  return url.toString();
}

function getSignalingServerUrl(argv = process.argv, env = process.env) {
  const commandLineUrl = readCommandLineServerUrl(argv);
  if (commandLineUrl !== null) {
    return validateServerUrl(commandLineUrl, '--server-url');
  }

  const environmentUrl = env.SYNCWATCH_SERVER_URL?.trim();
  if (environmentUrl) {
    return validateServerUrl(environmentUrl, 'SYNCWATCH_SERVER_URL');
  }

  return null;
}

async function resolveSignalingServerUrl({
  argv = process.argv,
  env = process.env,
  fetchImpl = globalThis.fetch,
  configUrl = DEFAULT_SERVER_URL_CONFIG,
  timeoutMs = SERVER_URL_CONFIG_TIMEOUT_MS,
  onRemoteConfigError = () => {},
} = {}) {
  const commandLineUrl = readCommandLineServerUrl(argv);
  if (commandLineUrl !== null) {
    return validateServerUrl(commandLineUrl, '--server-url');
  }

  if (typeof fetchImpl === 'function') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchImpl(configUrl, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        onRemoteConfigError(new Error(`Remote server config returned HTTP ${response.status}.`));
      } else {
        const remoteUrl = (await response.text()).trim();
        if (remoteUrl) {
          try {
            return validateServerUrl(remoteUrl, 'Remote server URL');
          } catch (error) {
            onRemoteConfigError(error);
          }
        }
      }
    } catch (error) {
      onRemoteConfigError(error);
      // Offline or unavailable remote configuration falls back to local configuration.
    } finally {
      clearTimeout(timeout);
    }
  }

  return getSignalingServerUrl(argv, env);
}

module.exports = { getSignalingServerUrl, resolveSignalingServerUrl };