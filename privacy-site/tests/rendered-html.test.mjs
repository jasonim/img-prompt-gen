import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the standalone IndexedDB installation page", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /枝句/);
  assert.match(html, /zhiju-prompt-collector-v0\.2\.0\.zip/);
  assert.match(html, /不需要 Node\.js、账号或配对/);
  assert.match(html, /IndexedDB/);
  assert.doesNotMatch(html, /43119|npm start|一次性配对密钥/);
});

test("server-renders the current privacy policy", async () => {
  const response = await render("/privacy");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /2026 年 8 月 26 日/);
  assert.match(html, /不申请网站主机权限/);
  assert.match(html, /不连接本地配套服务、开发者服务器或第三方服务器/);
  assert.doesNotMatch(html, /127\.0\.0\.1|HMAC|Token/);
});
