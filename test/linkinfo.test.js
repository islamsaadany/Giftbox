const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { linkInfo, linkStock, stockOf, isPrivate, toPrice } = require('../src/linkinfo');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
let server, base;
const pages = {
  '/meta': `<html><head><title>Ignored</title>
    <meta content="Baby car seat &amp; base" property="og:title">
    <meta property="og:image" content="/pic.jpg?a=1&amp;b=2">
    <meta property="product:price:amount" content="4,200.00"><meta property="product:price:currency" content="egp"></head></html>`,
  '/jsonld': `<html><head><title>Monitor | Shop</title><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},
    {"@type":"Product","name":"Baby monitor","image":["${'IMG'}"],"offers":{"@type":"Offer","price":"2100","priceCurrency":"EGP"}}]}</script></head></html>`,
  '/usd': `<meta property="og:image" content="/missing.jpg"><meta property="og:price:amount" content="49.99"><meta property="og:price:currency" content="USD">`,
  '/out': '<script type="application/ld+json">{"@type":"Product","name":"Pram","offers":{"@type":"Offer","price":"900","availability":"https://schema.org/OutOfStock"}}</script>',
  '/in': '<meta property="product:availability" content="in stock">',
  '/plain': '<html><head><title>Just a page</title></head><body>No product here</body></html>',
};
test.before(async () => {
  server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/pic.jpg') return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(JPEG);
    if (path === '/go') return res.writeHead(302, { Location: '/meta' }).end();
    if (path === '/removed') return res.writeHead(410).end();
    if (path === '/blocked') return res.writeHead(403).end();
    if (path === '/loop') return res.writeHead(302, { Location: '/loop' }).end();
    if (path === '/big.jpg') return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(Buffer.alloc(4 * 1024 * 1024));
    if (path === '/gz') return res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' }).end(zlib.gzipSync(pages['/meta']));
    if (pages[path]) return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(pages[path].replace('IMG', base + '/pic.jpg'));
    res.writeHead(404).end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => server.close());
const read = path => linkInfo(base + path, { allowPrivate: true });
const jpegUrl = 'data:image/jpeg;base64,' + JPEG.toString('base64');

test('reads the picture, price and name from a shop page', async () => {
  assert.deepEqual(await read('/meta'), { image: jpegUrl, price: 4200, currency: 'EGP', title: 'Baby car seat & base' });
  assert.deepEqual(await read('/jsonld'), { image: jpegUrl, price: 2100, currency: 'EGP', title: 'Baby monitor' });
  assert.deepEqual(await read('/go'), await read('/meta'));   // follows redirects
  assert.deepEqual(await read('/gz'), await read('/meta'));   // and compressed pages
  assert.deepEqual(await read('/pic.jpg'), { image: jpegUrl, price: null, currency: '', title: '' }); // the link is a picture
});

test('gives back what it can', async () => {
  assert.deepEqual(await read('/usd'), { image: null, price: 49.99, currency: 'USD', title: '' });
  assert.deepEqual(await read('/plain'), { image: null, price: null, currency: '', title: 'Just a page' });
  await assert.rejects(read('/nope'), { code: 'unreachable' });
  await assert.rejects(read('/loop'), { code: 'unreachable' });
  assert.equal((await read('/big.jpg')).image, null); // too big to pass on
});

test('never fetches private or local addresses', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'not-an-ip'])
    assert.equal(isPrivate(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivate(ip), false, ip);
  for (const link of [base + '/meta', 'http://localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.0.0.5/',
    'file:///etc/passwd', 'ftp://example.com/x', 'https://user:pw@example.com/', 'https://example.com:8443/', 'not a link'])
    await assert.rejects(linkInfo(link), { code: 'bad_link' }, link);
});

test('prices in the formats shops write them', () => {
  for (const [v, n] of [['4,200.00', 4200], ['4.200,00', 4200], ['480', 480], ['EGP 1,299', 1299], ['12,50', 12.5], ['1.299', 1299], ['49.99', 49.99], [2100, 2100], ['1.234.567', 1234567]])
    assert.equal(toPrice(v), n, String(v));
  for (const v of ['', 'free', null, undefined, -5, NaN]) assert.equal(toPrice(v), null, String(v));
});

test('reads whether the shop still has the product', async () => {
  const stock = path => linkStock(base + path, { allowPrivate: true });
  assert.equal(await stock('/out'), 'out');
  assert.equal(await stock('/in'), 'in');
  assert.equal(await stock('/nope'), 'gone');    // 404: the page no longer exists
  assert.equal(await stock('/removed'), 'gone');
  // No answer is not "out of stock": a page that doesn't say, a shop that blocks the request, a link that can't be fetched
  for (const path of ['/plain', '/meta', '/blocked', '/loop', '/pic.jpg']) assert.equal(await stock(path), null, path);
  assert.equal(await linkStock('http://127.0.0.1/'), null);
  assert.equal(await linkStock('not a link'), null);
});

test('availability in the ways shops publish it', () => {
  const ld = o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  const offer = a => ({ '@type': 'Offer', availability: a });
  assert.equal(stockOf(ld({ '@type': 'Product', offers: offer('http://schema.org/SoldOut') })), 'out');
  assert.equal(stockOf(ld({ '@type': 'Product', offers: offer('InStock') })), 'in');
  assert.equal(stockOf(ld({ '@type': 'Product', offers: offer({ '@id': 'https://schema.org/Discontinued' }) })), 'out');
  // one size left is still in stock; out only when every offer is out
  assert.equal(stockOf(ld({ '@type': 'Product', offers: [offer('https://schema.org/OutOfStock'), offer('https://schema.org/InStock')] })), 'in');
  assert.equal(stockOf(ld({ '@type': 'Product', offers: { '@type': 'AggregateOffer', offers: [offer('OutOfStock'), offer('OutOfStock')] } })), 'out');
  assert.equal(stockOf(ld({ '@type': 'ProductGroup', hasVariant: [{ '@type': 'Product', offers: offer('OutOfStock') }, { '@type': 'Product', offers: offer('PreOrder') }] })), 'in');
  // the page's own product decides, not a "you may also like" product listed after it
  assert.equal(stockOf(ld([{ '@type': 'Product', offers: offer('OutOfStock') }, { '@type': 'Product', offers: offer('InStock') }])), 'out');
  assert.equal(stockOf('<meta property="og:availability" content="Out of Stock">'), 'out');
  assert.equal(stockOf('<meta property="product:availability" content="oos">'), 'out');
  assert.equal(stockOf('<link itemprop="availability" href="https://schema.org/OutOfStock">'), 'out');
  assert.equal(stockOf('<meta content="https://schema.org/InStock" itemprop="availability">'), 'in');
  assert.equal(stockOf(ld({ '@type': 'Product', offers: { '@type': 'Offer', price: 5 } })), null);
  assert.equal(stockOf('<p>Sorry, out of stock</p>'), null); // only what the page publishes as data
});
