import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError, formatHttpError } from "../src/lib/http.js";
import { cboeTools } from "../src/providers/cboe.js";

test("generic 403 output does not expose URLs, bodies, or guessed causes", () => {
  const error = new HttpError(
    403,
    "https://example.com/quote?apikey=secret-key",
    "<Error>private-response</Error>",
  );
  const message = formatHttpError(error);
  assert.match(message, /HTTP 403/);
  assert.doesNotMatch(message, /secret-key|private-response|missing API key|required User-Agent|IP restriction/);
});

const alternatives = ["yahoo_quote", "yahoo_chart", "yahoo_options_chain"];
const paths = ["quotes", "charts/historical", "options"];

for (const [index, tool] of cboeTools.entries()) {
  test(`${tool.name}: denied symbol keeps its status and offers an explicit alternative`, async (t) => {
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => {
      calls.push(url);
      return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    });
    await assert.rejects(tool.handler({ symbol: " vow3.de " }), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 403);
      const message = formatHttpError(error);
      assert.match(message, /Cboe.*"VOW3.DE"/);
      assert.match(message, /yahoo_search/);
      assert.ok(message.includes(alternatives[index]!));
      assert.doesNotMatch(message, /Unexpected error|IP restriction|missing API key/);
      return true;
    });
    assert.deepEqual(calls, [
      `https://cdn.cboe.com/api/global/delayed_quotes/${paths[index]}/VOW3.DE.json`,
    ]); // No automatic provider switch or retry of a permanent refusal.
  });
}

test("Cboe success retains data and caching", async (t) => {
  const data = { symbol: "AAPL", data: { current_price: 200 } };
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(data));
  const quote = cboeTools[0]!;
  assert.deepEqual(await quote.handler({ symbol: " aapl " }), data);
  assert.deepEqual(await quote.handler({ symbol: "AAPL" }), data);
  assert.equal(fetch.mock.callCount(), 1);
});

test("Cboe non-403 errors keep their original classification", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  await assert.rejects(cboeTools[0]!.handler({ symbol: "MISSING" }), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 404);
    assert.equal(error.hint, undefined);
    assert.match(formatHttpError(error), /Not found \(HTTP 404\)/);
    return true;
  });
});
