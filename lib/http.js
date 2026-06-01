module.exports.fetchWithTimeout = async function fetchWithTimeout(url, opts = {}) {
  const timeout = opts.timeout || 10000;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const signal = controller ? controller.signal : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;

  try {
    const res = await fetch(url, { ...opts, signal });
    if (timer) clearTimeout(timer);
    return res;
  } catch (err) {
    if (timer) clearTimeout(timer);
    throw err;
  }
};
