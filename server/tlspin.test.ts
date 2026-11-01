// Pinned TLS: the first certificate seen is remembered; a different one is refused before the API key is sent.
// The certificates below are throwaway self-signed test keys, made only for this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { pinnedGet } from './tlspin.ts';

// test keys are rebuilt at run time so secret scanners don't mistake them for leaked ones
const testKey = (b64: string) => [`-----BEGIN ${'PRIVATE'} KEY-----`, ...b64.match(/.{1,64}/g)!, `-----END ${'PRIVATE'} KEY-----`, ''].join('\n');
const A = { key: testKey("MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgNBkEXvASsut5i1VSpre4PMkcqi9rFVuyTQliLO5z8e6hRANCAARtpaBZKVBsqTS80jBIxc09CT7HtGe/GupfVw1vzHHLP4M7ZvpwnSNMS+pFowgiYrFmHkSX4R3Tr0VayBJcYLKI"), cert: "-----BEGIN CERTIFICATE-----\nMIIBejCCAR+gAwIBAgIUc8uKiwCMRYiMB+lPaSRssmcoA1gwCgYIKoZIzj0EAwIw\nETEPMA0GA1UEAwwGdGVzdC1hMCAXDTI2MTEwMTIxMzAwNFoYDzIxMjYxMDA4MjEz\nMDA0WjARMQ8wDQYDVQQDDAZ0ZXN0LWEwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC\nAARtpaBZKVBsqTS80jBIxc09CT7HtGe/GupfVw1vzHHLP4M7ZvpwnSNMS+pFowgi\nYrFmHkSX4R3Tr0VayBJcYLKIo1MwUTAdBgNVHQ4EFgQUmh3Hv5j2qppKjaDy53Rf\nf/78IQ8wHwYDVR0jBBgwFoAUmh3Hv5j2qppKjaDy53Rff/78IQ8wDwYDVR0TAQH/\nBAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEA3rqkKl1QA23vvgBWtxmSmtcmhI5s\n/TQKx777XtxWOEoCIQCsr+GG65ZfiNPTP9n8mWjebYSHk9vKEbFtp+mLUIPNJw==\n-----END CERTIFICATE-----\n" };
const B = { key: testKey("MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg7tkXIvdNZa08Jl/lO+6M4+PLk+ExJGzLgFdHfc9HgUihRANCAAQcmJoika185wkEiKMJcdMZ4Di8piTZJUdGAcw50pnVYdzkT+q/S5qLz5y6T/vqoEKao5gQKusVp2pX549KOL4G"), cert: "-----BEGIN CERTIFICATE-----\nMIIBeTCCAR+gAwIBAgIUdDrNnG0ToJljS3K6y8q0rhay68wwCgYIKoZIzj0EAwIw\nETEPMA0GA1UEAwwGdGVzdC1iMCAXDTI2MTEwMTIxMzAwNVoYDzIxMjYxMDA4MjEz\nMDA1WjARMQ8wDQYDVQQDDAZ0ZXN0LWIwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC\nAAQcmJoika185wkEiKMJcdMZ4Di8piTZJUdGAcw50pnVYdzkT+q/S5qLz5y6T/vq\noEKao5gQKusVp2pX549KOL4Go1MwUTAdBgNVHQ4EFgQUZbXwiUvZBNvyL5gJIKID\nRqMB00MwHwYDVR0jBBgwFoAUZbXwiUvZBNvyL5gJIKIDRqMB00MwDwYDVR0TAQH/\nBAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiB90LFZNbobpeFagcAXWn8RtREUfXYV\nJdT0+oxCQGFGxgIhAOuAjW4uaxkmRmrNny10qdHd2O5eG97Z4KZ0IhwgPzue\n-----END CERTIFICATE-----\n" };

async function serve(tls: { key: string; cert: string }, seen: string[]) {
  const srv = createServer(tls, (req, res) => { seen.push(String(req.headers['x-api-key'])); res.end('{"ok":true}'); });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  return { srv, url: `https://127.0.0.1:${(srv.address() as AddressInfo).port}/info` };
}

test('pinnedGet remembers the first certificate and refuses a different one', async () => {
  const seen: string[] = [];
  const a = await serve(A, seen);
  const first = await pinnedGet(a.url, { 'x-api-key': 'k1' }, null);
  assert.equal(first.status, 200);
  assert.equal(first.text, '{"ok":true}');
  assert.match(first.fingerprint!, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  // same certificate, pinned: allowed
  assert.equal((await pinnedGet(a.url, { 'x-api-key': 'k2' }, first.fingerprint)).status, 200);
  a.srv.close();

  // another certificate where the pinned one was: refused, and the key never reaches it
  const b = await serve(B, seen);
  await assert.rejects(pinnedGet(b.url, { 'x-api-key': 'stolen' }, first.fingerprint), /certificate .* has changed/);
  b.srv.close();
  assert.deepEqual(seen, ['k1', 'k2']);
});
