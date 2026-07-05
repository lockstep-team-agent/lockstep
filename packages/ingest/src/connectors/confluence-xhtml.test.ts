import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfluenceXhtml } from "./ConfluenceConnector.js";

test("parseConfluenceXhtml: h1/h2/p map to heading levels and body text in document order", () => {
  const xhtml =
    "<h1>Guest Checkout</h1>" +
    "<p>Guests must be able to complete checkout.</p>" +
    "<h2>Requirements</h2>" +
    "<p>The flow must not present an OTP before payment.</p>";
  const paras = parseConfluenceXhtml(xhtml);
  assert.deepEqual(paras, [
    { level: 1, text: "Guest Checkout" },
    { level: null, text: "Guests must be able to complete checkout." },
    { level: 2, text: "Requirements" },
    { level: null, text: "The flow must not present an OTP before payment." },
  ]);
});

test("parseConfluenceXhtml: h3–h6 keep their numeric level; unmatched blocks (tables/li) are ignored", () => {
  const xhtml =
    "<h3>Deep</h3><h6>Deepest</h6>" +
    "<table><tr><td>ignored cell</td></tr></table>" +
    "<ul><li>ignored bullet</li></ul>" +
    "<p>kept</p>";
  const paras = parseConfluenceXhtml(xhtml);
  assert.deepEqual(paras, [
    { level: 3, text: "Deep" },
    { level: 6, text: "Deepest" },
    { level: null, text: "kept" },
  ]);
});

test("parseConfluenceXhtml: strips inline tags and ac:/ri: macros, collapsing to plain text", () => {
  const xhtml =
    "<p>Payments run on <strong>Stripe</strong> only " +
    '<ac:structured-macro ac:name="info"><ac:rich-text-body>note</ac:rich-text-body></ac:structured-macro>' +
    '<ac:link><ri:page ri:content-title="Spec" /></ac:link> today.</p>';
  const paras = parseConfluenceXhtml(xhtml);
  assert.equal(paras.length, 1);
  assert.equal(paras[0]!.level, null);
  // Every tag (incl. ac:/ri: macros) is dropped; residual whitespace is collapsed.
  assert.equal(paras[0]!.text, "Payments run on Stripe only note today.");
});

test("parseConfluenceXhtml: decodes XML entities (incl. &amp; last, so &amp;lt; survives)", () => {
  const xhtml = "<p>A &amp; B &lt; C &gt; D said &quot;hi&quot; it&#39;s fine; literal &amp;lt; kept</p>";
  const paras = parseConfluenceXhtml(xhtml);
  assert.equal(paras[0]!.text, `A & B < C > D said "hi" it's fine; literal &lt; kept`);
});

test("parseConfluenceXhtml: attributes on the tag don't break the match; empty doc yields []", () => {
  assert.deepEqual(parseConfluenceXhtml(""), []);
  const paras = parseConfluenceXhtml('<h2 data-x="1">Titled</h2><p class="body">text</p>');
  assert.deepEqual(paras, [
    { level: 2, text: "Titled" },
    { level: null, text: "text" },
  ]);
});
