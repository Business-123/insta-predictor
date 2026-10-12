'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

// Guards against the things that made fields on the sign-in / sign-up pages sometimes ignore a tap.
for (const page of ['/login', '/signup']) {
  test(`${page}: nothing on the page can swallow taps meant for the form fields`, async t => {
    const h = await boot(t);
    const html = (await h.request(page)).text;
    assert.doesNotMatch(html, /backdrop-blur/, 'backdrop-filter on the form breaks input focus on some phones');
    assert.doesNotMatch(html, /blur-\[\d+px\]/, 'huge blur filters make phones drop taps');
    for (const tag of html.match(/<div[^>]*(?:fixed|animate-ping)[^>]*>|<span[^>]*animate-ping[^>]*>/g) || []) {
      if (/inset-0|animate-ping/.test(tag) && !/support-fab/.test(tag)) assert.match(tag, /pointer-events-none/, `overlay can block taps: ${tag.slice(0, 80)}`);
    }
    assert.match(html, /href="\/auth-fixes\.css"/);
    assert.doesNotMatch(html, /autocomplete="username"/, 'password-manager popups can cover the next field');
    const css = await h.request('/auth-fixes.css');
    assert.equal(css.status, 200);
    assert.match(css.text, /font-size: 16px/, 'iOS zooms the page on fields under 16px');
    assert.match(css.text, /touch-action: manipulation/);
    assert.match(css.text, /#support-fab span \{ pointer-events: none/);
  });
}
