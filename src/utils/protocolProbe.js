import tls from 'node:tls';
import net from 'node:net';

export const PROTOCOL_NEGOTIATION_VERSION = 'http-protocol-negotiation-v1';

const CERTIFICATE_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
]);

export async function probeTlsProtocol(url, options = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    return {
      version: PROTOCOL_NEGOTIATION_VERSION,
      state: 'not_applicable',
      url: parsed.toString(),
      attempts: []
    };
  }
  const attempts = [];
  const maximum = Math.max(1, Number(options.attempts ?? 2));
  for (let attempt = 1; attempt <= maximum; attempt += 1) {
    const result = await oneTlsProbe(parsed, options);
    attempts.push({ attempt, ...result });
    if (result.state === 'connected') break;
  }
  const successful = attempts.find((attempt) => attempt.state === 'connected');
  const certificateFailure = attempts.find((attempt) => attempt.errorClass === 'certificate_error');
  const selected = successful || certificateFailure || attempts.at(-1);
  return {
    version: PROTOCOL_NEGOTIATION_VERSION,
    url: parsed.toString(),
    state: selected?.state || 'technical_error',
    negotiatedProtocol: selected?.negotiatedProtocol || null,
    tlsProtocol: selected?.tlsProtocol || null,
    authorized: selected?.authorized ?? false,
    authorizationError: selected?.authorizationError || null,
    certificate: selected?.certificate || null,
    error: selected?.error || null,
    errorCode: selected?.errorCode || null,
    errorClass: selected?.errorClass || null,
    attempts
  };
}

export function classifyTlsError(error) {
  const code = String(error?.code || '').toUpperCase();
  if (CERTIFICATE_ERROR_CODES.has(code)) return 'certificate_error';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_error';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'connection_reset';
  if (code === 'ETIMEDOUT' || code === 'ERR_SOCKET_CONNECTION_TIMEOUT') return 'timeout';
  return 'technical_error';
}

function oneTlsProbe(parsed, options) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 8000));
  return new Promise((resolve) => {
    let settled = false;
    const socket = tls.connect({
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 443,
      servername: net.isIP(parsed.hostname) ? undefined : parsed.hostname,
      ALPNProtocols: ['h2', 'http/1.1'],
      rejectUnauthorized: options.rejectUnauthorized !== false
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => {
      const error = new Error(`TLS connection timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      finish(errorResult(error));
    });
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate();
      finish({
        state: 'connected',
        negotiatedProtocol: socket.alpnProtocol || 'http/1.1',
        tlsProtocol: socket.getProtocol() || null,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError || null,
        certificate: compactCertificate(peer)
      });
    });
    socket.once('error', (error) => finish(errorResult(error)));
  });
}

function errorResult(error) {
  return {
    state: 'technical_error',
    error: error?.message || String(error),
    errorCode: error?.code || null,
    errorClass: classifyTlsError(error),
    negotiatedProtocol: null,
    tlsProtocol: null,
    authorized: false,
    authorizationError: error?.code || null,
    certificate: null
  };
}

function compactCertificate(peer = {}) {
  if (!peer || !Object.keys(peer).length) return null;
  return {
    subject: peer.subject?.CN || null,
    issuer: peer.issuer?.CN || null,
    subjectAlternativeNames: parseSubjectAlternativeNames(peer.subjectaltname),
    validFrom: peer.valid_from || null,
    validTo: peer.valid_to || null,
    fingerprint256: peer.fingerprint256 || null,
    serialNumber: peer.serialNumber || null
  };
}

function parseSubjectAlternativeNames(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().replace(/^DNS:/i, ''))
    .filter(Boolean)
    .slice(0, 50);
}
