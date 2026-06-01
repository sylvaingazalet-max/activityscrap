module.exports.validatePayload = function validatePayload(body) {
  if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
    return 'Missing prompt';
  }
  return null;
};
