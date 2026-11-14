/**
 * লোকাল S3-সামঞ্জস্যপূর্ণ নকল সার্ভার — শুধু টেস্টের জন্য।
 *
 * এটা signature পুরোপুরি যাচাই করে না, কিন্তু যা যাচাই করে সেটাই আসল ভুল ধরার জন্য যথেষ্ট:
 *   • Authorization হেডার আছে এবং scope সঠিক (…/s3/aws4_request)
 *   • x-amz-content-sha256 আসল body-র sha256-এর সাথে মেলে
 *   • x-amz-date আছে
 * ভুল মেথড/বডি/পাথ হলে টেস্ট ফেল করবে।
 */

import crypto from 'node:crypto';
import http from 'node:http';

export function startMockS3({ accessKeyId = 'test-access-key', bucket = 'test-bucket' } = {}) {
  const objects = new Map(); // key → Buffer
  const problems = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://127.0.0.1');
      const auth = String(req.headers.authorization || '');

      if (!auth.startsWith('AWS4-HMAC-SHA256 Credential=')) problems.push(`bad auth header: ${auth.slice(0, 40)}`);
      if (!auth.includes(`Credential=${accessKeyId}/`)) problems.push('wrong access key id in scope');
      if (!/\/s3\/aws4_request/.test(auth)) problems.push('wrong credential scope');
      if (!req.headers['x-amz-date']) problems.push('missing x-amz-date');

      const claimed = String(req.headers['x-amz-content-sha256'] || '');
      const actual = crypto.createHash('sha256').update(body).digest('hex');
      if (claimed !== actual) problems.push(`payload hash mismatch on ${req.method} ${url.pathname}`);

      const [, bucketName, ...rest] = url.pathname.split('/');
      const key = decodeURIComponent(rest.join('/'));

      if (bucketName !== bucket) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        return res.end('<Error><Code>NoSuchBucket</Code><Message>no bucket</Message></Error>');
      }

      if (req.method === 'PUT') {
        objects.set(key, body);
        res.writeHead(200, { etag: `"${actual}"` });
        return res.end();
      }

      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') || '';
        const max = Number(url.searchParams.get('max-keys') || 1000);
        const items = [...objects.entries()].filter(([k]) => k.startsWith(prefix)).slice(0, max);
        const contents = items
          .map(
            ([k, v]) =>
              `<Contents><Key>${escapeXml(k)}</Key><Size>${v.length}</Size>` +
              `<LastModified>${new Date().toISOString()}</LastModified></Contents>`,
          )
          .join('');
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<?xml version="1.0"?><ListBucketResult>${contents}</ListBucketResult>`);
      }

      if (req.method === 'GET') {
        if (!objects.has(key)) {
          res.writeHead(404, { 'content-type': 'application/xml' });
          return res.end('<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>');
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(objects.get(key));
      }

      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        return res.end();
      }

      res.writeHead(405);
      res.end();
    });
  });

  return {
    objects,
    problems,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
