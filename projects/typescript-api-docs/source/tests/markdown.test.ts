import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../src/markdown';

const baseUrl = 'https://docs.example.test/reference/index.html';

test('renders headings, lists, fences, emphasis, and inline code without a DOM', () => {
  const rendered = renderMarkdown([
    '# Heading',
    '',
    '- first',
    '- second',
    '',
    '3. third',
    '4. fourth',
    '',
    '```ts',
    'const value = "<unsafe>";',
    '```',
    '',
    '*italic* **bold** ***both*** and `inline <code>`',
  ].join('\n'), baseUrl);

  assert.match(rendered, /^<h1>Heading<\/h1>/u);
  assert.match(rendered, /<ul><li><p>first<\/p><\/li><li><p>second<\/p><\/li><\/ul>/u);
  assert.match(rendered, /<ol start="3"><li><p>third<\/p><\/li><li><p>fourth<\/p><\/li><\/ol>/u);
  assert.match(rendered, /<pre><code>const value = &quot;&lt;unsafe&gt;&quot;;<\/code><\/pre>/u);
  assert.match(rendered, /<em>italic<\/em> <strong>bold<\/strong> <strong><em>both<\/em><\/strong>/u);
  assert.match(rendered, /<code>inline &lt;code&gt;<\/code>/u);
});

test('uses a safe browser-compatible default base URL in node', () => {
  assert.equal(renderMarkdown('[home](/docs)'), '<p><a href="http://localhost/docs">home</a></p>');
});

test('renders safe absolute, relative, and mailto links', () => {
  const rendered = renderMarkdown('[absolute](https://example.com/api?q=1) [relative](/docs) [mail](mailto:docs@example.com)', baseUrl);

  assert.match(rendered, /<a href="https:\/\/example\.com\/api\?q=1">absolute<\/a>/u);
  assert.match(rendered, /<a href="https:\/\/docs\.example\.test\/docs">relative<\/a>/u);
  assert.match(rendered, /<a href="mailto:docs@example\.com">mail<\/a>/u);
});

test('escapes hostile raw script, image, and HTML as text', () => {
  const rendered = renderMarkdown('<script>alert(1)</script><img src=x onerror=alert(1)><div class="hostile">text</div>', baseUrl);

  assert.equal(rendered, '<p>&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;&lt;div class=&quot;hostile&quot;&gt;text&lt;/div&gt;</p>');
  assert.doesNotMatch(rendered, /<\/?(?:script|img|div)\b/iu);
});

test('escapes quotes in link URLs without allowing attribute injection', () => {
  const rendered = renderMarkdown('[link](https://example.com/?q="onfocus="alert(1))', baseUrl);

  assert.match(rendered, /href="https:\/\/example\.com\/\?q=%22onfocus=%22alert\(1\)"/u);
  assert.doesNotMatch(rendered, /"\s+(?:autofocus|onfocus)(?:=|\s|>)/iu);
});

test('rejects dangerous link schemes and URL normalization tricks', () => {
  const destinations = [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '%6a%61%76%61%73%63%72%69%70%74%3Aalert(1)',
    'java%0ascript:alert(1)',
    'java&#x09;script:alert(1)',
    '//evil.example/path',
    'https:\\evil.example/path',
  ];

  for (const destination of destinations) {
    const rendered = renderMarkdown(`[unsafe](${destination})`, baseUrl);
    assert.doesNotMatch(rendered, /<a\b/iu, destination);
  }
});
