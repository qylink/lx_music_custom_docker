'use strict';

function ok(data, message = 'ok') {
  return { code: 0, message, data };
}

function fail(message, code = 1, data = null) {
  return { code, message, data };
}

async function safeJson(reply, promise, errorMessage) {
  try {
    const data = await promise;
    reply.send(ok(data));
  } catch (err) {
    request.log.error(err);
    reply.code(500).send(fail(err.message || errorMessage || 'internal error'));
  }
}

module.exports = { ok, fail, safeJson };
