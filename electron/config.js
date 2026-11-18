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

module.exports = { getSignalingServerUrl };