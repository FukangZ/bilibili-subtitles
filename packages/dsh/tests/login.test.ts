import assert from "node:assert/strict";
import { test } from "node:test";
import { SubtitleError, type LoginCookie, type LoginProgress } from "@fukangz/core-bilibili-subtitles";
import { COOKIE_KEY, saveCookie } from "../dist/credentials.js";
import { LoginManager, registerLoginRoutes, ROUTE_PREFIX } from "../dist/login.js";
import { fakeHost } from "./helpers.ts";

const cookie: LoginCookie = { SESSDATA: "secret-session", bili_jct: "jct-value", DedeUserID: "42" };

interface Script {
  progress(value: LoginProgress): void;
  resolve(value: LoginCookie): void;
  reject(error: unknown): void;
  signal: AbortSignal;
}

function scriptedLogin() {
  const runs: Script[] = [];
  const login = (input: { signal?: AbortSignal; onProgress?: (p: LoginProgress) => void }) =>
    new Promise<LoginCookie>((resolve, reject) => {
      runs.push({ progress: (p) => input.onProgress?.(p), resolve, reject, signal: input.signal! });
    });
  return { runs, login: login as never };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("扫码登录状态流转：二维码模块、成功后保存 Cookie", async () => {
  const saved: LoginCookie[] = [];
  const { runs, login } = scriptedLogin();
  const manager = new LoginManager({ save: async (c: LoginCookie) => { saved.push(c); }, login });
  const { id, status } = manager.start();
  assert.deepEqual(status, { state: "generating" });
  runs[0].progress({ state: "waiting", url: "https://passport.bilibili.com/qr?k=1", expiresAt: 1000 });
  const waiting = manager.poll(id) as { state: string; size: number; rows: string[] };
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.rows.length, waiting.size);
  assert.match(waiting.rows[0], /^[01]+$/);
  runs[0].resolve(cookie);
  await tick();
  assert.deepEqual(manager.poll(id), { state: "success", userId: "42" });
  assert.deepEqual(saved, [cookie]);
});

test("新登录取消旧会话；取消后结果不再保存", async () => {
  const saved: LoginCookie[] = [];
  const { runs, login } = scriptedLogin();
  const manager = new LoginManager({ save: async (c: LoginCookie) => { saved.push(c); }, login });
  const first = manager.start();
  const second = manager.start();
  assert.equal(runs[0].signal.aborted, true);
  assert.deepEqual(manager.poll(first.id), { state: "cancelled" });
  runs[0].resolve(cookie);
  assert.equal(manager.cancel(second.id), true);
  runs[1].resolve(cookie);
  await tick();
  assert.deepEqual(saved, []);
  assert.deepEqual(manager.poll(second.id), { state: "cancelled" });
});

test("保存已经开始时明确拒绝取消，不谎报 cancelled 后又变成 success", async () => {
  const saving = deferred();
  const release = deferred();
  const saved: LoginCookie[] = [];
  const { runs, login } = scriptedLogin();
  const manager = new LoginManager({
    login,
    save: async (value) => {
      saving.resolve();
      await release.promise;
      saved.push(value);
    },
  });
  const { id } = manager.start();
  runs[0].resolve(cookie);
  await saving.promise;
  const before = manager.poll(id);
  const accepted = manager.cancel(id);
  const after = manager.poll(id);
  release.resolve();
  await tick();
  assert.equal(accepted, false);
  assert.deepEqual(before, { state: "saving" });
  assert.deepEqual(after, before);
  assert.deepEqual(manager.poll(id), { state: "success", userId: "42" });
  assert.deepEqual(saved, [cookie]);
});

test("登录错误去掉错误码前缀；完成的会话 60 秒后清理", async () => {
  let now = 0;
  const { runs, login } = scriptedLogin();
  const manager = new LoginManager({ save: async () => {}, login, now: () => now });
  const { id } = manager.start();
  runs[0].reject(new SubtitleError("LOGIN_EXPIRED", "二维码已过期"));
  await tick();
  assert.deepEqual(manager.poll(id), { state: "error", code: "LOGIN_EXPIRED", message: "二维码已过期" });
  now = 60_001;
  assert.equal(manager.poll(id), undefined);
});

test("路由登出使此前启动的登录失效，旧结果不能恢复凭据，新登录仍可用", async () => {
  const host = fakeHost({ cwd: "" });
  host.records.set(COOKIE_KEY, { kind: "grant", payload: cookie });
  const { runs, login } = scriptedLogin();
  const manager = new LoginManager({ login, save: (value) => saveCookie(host.ctx.credentials, value) });
  registerLoginRoutes(host.ctx, manager);
  const first = manager.start();
  const route = host.routes.get(`${ROUTE_PREFIX}/account/logout`)!;
  const response = await route.fetch(new Request("http://host/logout", { method: "POST" }));
  assert.equal(response.status, 200);
  assert.equal(host.records.has(COOKIE_KEY), false);
  runs[0].resolve(cookie);
  await tick();
  assert.equal(host.records.has(COOKIE_KEY), false);
  assert.deepEqual(manager.poll(first.id), { state: "cancelled" });
  const second = manager.start();
  runs[1].resolve(cookie);
  await tick();
  assert.deepEqual(manager.poll(second.id), { state: "success", userId: "42" });
  assert.deepEqual(host.records.get(COOKIE_KEY), { kind: "grant", payload: cookie });
});

test("路由登出等待在途保存再删除；保存期间取消返回冲突且不谎报成功", async () => {
  const host = fakeHost({ cwd: "" });
  const saving = deferred();
  const release = deferred();
  const modify = host.ctx.credentials.modifyRecord;
  host.ctx.credentials.modifyRecord = (key, update) => modify(key, async (current) => {
    const next = await update(current);
    saving.resolve();
    await release.promise;
    return next;
  });
  const { runs, login } = scriptedLogin();
  const manager = new LoginManager({ login, save: (value) => saveCookie(host.ctx.credentials, value) });
  registerLoginRoutes(host.ctx, manager);
  const { id } = manager.start();
  runs[0].resolve(cookie);
  await saving.promise;
  const cancel = await host.routes.get(`${ROUTE_PREFIX}/login/cancel`)!.fetch(new Request("http://host/cancel", {
    method: "POST", body: JSON.stringify({ id }),
  }));
  assert.equal(cancel.status, 409);
  assert.deepEqual(await cancel.json(), { error: "LOGIN_SAVING" });
  assert.deepEqual(manager.poll(id), { state: "saving" });
  let returned = false;
  const logout = host.routes.get(`${ROUTE_PREFIX}/account/logout`)!.fetch(new Request("http://host/logout", { method: "POST" }))
    .then((response) => { returned = true; return response; });
  await tick();
  const returnedBeforeSave = returned;
  release.resolve();
  const response = await logout;
  await tick();
  assert.equal(returnedBeforeSave, false);
  assert.equal(response.status, 200);
  assert.equal(host.records.has(COOKIE_KEY), false);
  assert.deepEqual(manager.poll(id), { state: "cancelled" });
});

test("旧保存进行中时串行保存新登录，已被替代的排队会话不写凭据", async () => {
  const saving = deferred();
  const release = deferred();
  const saved: LoginCookie[] = [];
  const { runs, login } = scriptedLogin();
  const manager = new LoginManager({ login, save: async (value) => {
    if (saved.length === 0) { saving.resolve(); await release.promise; }
    saved.push(value);
  } });
  const first = manager.start();
  runs[0].resolve(cookie);
  await saving.promise;
  const second = manager.start();
  runs[1].resolve({ ...cookie, DedeUserID: "84" });
  await tick();
  const third = manager.start();
  const newest = { ...cookie, DedeUserID: "126" };
  runs[2].resolve(newest);
  await tick();
  assert.deepEqual(manager.poll(first.id), { state: "saving" });
  assert.deepEqual(manager.poll(second.id), { state: "cancelled" });
  release.resolve();
  await tick();
  assert.deepEqual(saved, [cookie, newest]);
  assert.deepEqual(manager.poll(first.id), { state: "success", userId: "42" });
  assert.deepEqual(manager.poll(third.id), { state: "success", userId: "126" });
});

test("停用使未提交会话失效并等待在途写入，不允许复用已停用管理器", async () => {
  const saving = deferred();
  const release = deferred();
  const saved: LoginCookie[] = [];
  const { runs, login } = scriptedLogin();
  const manager = new LoginManager({ login, save: async (value) => {
    saving.resolve();
    await release.promise;
    saved.push(value);
  } });
  manager.start();
  runs[0].resolve(cookie);
  await saving.promise;
  const queued = manager.start();
  runs[1].resolve({ ...cookie, DedeUserID: "84" });
  await tick();
  let returned = false;
  const disposed = Promise.resolve(manager.dispose()).then(() => { returned = true; });
  await tick();
  const returnedBeforeSave = returned;
  release.resolve();
  await disposed;
  await tick();
  assert.equal(returnedBeforeSave, false);
  assert.deepEqual(saved, [cookie]);
  assert.equal(runs[1].signal.aborted, true);
  assert.equal(manager.poll(queued.id), undefined);
  assert.throws(() => manager.start(), /disposed/);
});

test("零时钟完成的会话不可被取消、迟到进度或新登录改写", async () => {
  let now = 0;
  const { runs, login } = scriptedLogin();
  const manager = new LoginManager({ login, save: async () => {}, now: () => now });
  const first = manager.start();
  runs[0].resolve(cookie);
  await tick();
  assert.equal(manager.cancel(first.id), true);
  runs[0].progress({ state: "generating" });
  manager.start();
  assert.deepEqual(manager.poll(first.id), { state: "success", userId: "42" });
  now = 60_001;
  assert.equal(manager.poll(first.id), undefined);
  await manager.dispose();
});

test("保存失败保留原凭据，队列仍接受新登录和登出", async () => {
  const host = fakeHost({ cwd: "" });
  const old = { kind: "grant", payload: cookie };
  host.records.set(COOKIE_KEY, old);
  const { runs, login } = scriptedLogin();
  let fail = true;
  const manager = new LoginManager({ login, save: async (value) => {
    if (fail) throw new Error("simulated store failure");
    await saveCookie(host.ctx.credentials, value);
  } });
  registerLoginRoutes(host.ctx, manager);
  const first = manager.start();
  runs[0].resolve({ ...cookie, DedeUserID: "84" });
  await tick();
  assert.deepEqual(manager.poll(first.id), { state: "error", code: "LOGIN_FAILED", message: "登录失败" });
  assert.deepEqual(host.records.get(COOKIE_KEY), old);
  fail = false;
  const second = manager.start();
  runs[1].resolve({ ...cookie, DedeUserID: "126" });
  await tick();
  assert.deepEqual(manager.poll(second.id), { state: "success", userId: "126" });
  const response = await host.routes.get(`${ROUTE_PREFIX}/account/logout`)!.fetch(new Request("http://host/logout", { method: "POST" }));
  assert.equal(response.status, 200);
  assert.equal(host.records.has(COOKIE_KEY), false);
});

test("会话容量清理不能丢失在途保存，登出仍须等待并删除", async () => {
  const host = fakeHost({ cwd: "" });
  const saving = deferred();
  const release = deferred();
  const { runs, login } = scriptedLogin();
  const manager = new LoginManager({ login, save: async (value) => {
    saving.resolve();
    await release.promise;
    await saveCookie(host.ctx.credentials, value);
  } });
  registerLoginRoutes(host.ctx, manager);
  const first = manager.start();
  runs[0].resolve(cookie);
  await saving.promise;
  for (let i = 0; i < 6; i += 1) manager.start();
  const status = manager.poll(first.id);
  const logout = host.routes.get(`${ROUTE_PREFIX}/account/logout`)!.fetch(new Request("http://host/logout", { method: "POST" }));
  release.resolve();
  assert.equal((await logout).status, 200);
  assert.deepEqual(status, { state: "saving" });
  assert.equal(host.records.has(COOKIE_KEY), false);
});

test("登出删除期间启动的新登录排在删除之后，旧登录不恢复", async () => {
  const host = fakeHost({ cwd: "" });
  host.records.set(COOKIE_KEY, { kind: "grant", payload: cookie });
  const deleting = deferred();
  const release = deferred();
  const remove = host.ctx.credentials.deleteRecord;
  host.ctx.credentials.deleteRecord = async (key) => {
    deleting.resolve();
    await release.promise;
    await remove(key);
  };
  const { runs, login } = scriptedLogin();
  const manager = new LoginManager({ login, save: (value) => saveCookie(host.ctx.credentials, value) });
  registerLoginRoutes(host.ctx, manager);
  const old = manager.start();
  const logout = host.routes.get(`${ROUTE_PREFIX}/account/logout`)!.fetch(new Request("http://host/logout", { method: "POST" }));
  await deleting.promise;
  const fresh = manager.start();
  runs[0].resolve(cookie);
  const next = { ...cookie, DedeUserID: "84" };
  runs[1].resolve(next);
  await tick();
  assert.deepEqual(manager.poll(fresh.id), { state: "generating" });
  release.resolve();
  assert.equal((await logout).status, 200);
  await tick();
  assert.deepEqual(manager.poll(old.id), { state: "cancelled" });
  assert.deepEqual(manager.poll(fresh.id), { state: "success", userId: "84" });
  assert.deepEqual(host.records.get(COOKIE_KEY), { kind: "grant", payload: next });
});

test("保存中登出遇到保存失败仍删除凭据，迟到错误不覆盖 cancelled", async () => {
  const host = fakeHost({ cwd: "" });
  host.records.set(COOKIE_KEY, { kind: "grant", payload: cookie });
  const saving = deferred();
  const release = deferred();
  const { runs, login } = scriptedLogin();
  const manager = new LoginManager({ login, save: async () => {
    saving.resolve();
    await release.promise;
    throw new Error("simulated failure");
  } });
  registerLoginRoutes(host.ctx, manager);
  const { id } = manager.start();
  runs[0].resolve(cookie);
  await saving.promise;
  const logout = host.routes.get(`${ROUTE_PREFIX}/account/logout`)!.fetch(new Request("http://host/logout", { method: "POST" }));
  release.resolve();
  assert.equal((await logout).status, 200);
  await tick();
  assert.deepEqual(manager.poll(id), { state: "cancelled" });
  assert.equal(host.records.has(COOKIE_KEY), false);
});

test("登出删除失败向调用者报告，失败不阻塞之后的登出", async () => {
  const host = fakeHost({ cwd: "" });
  host.records.set(COOKIE_KEY, { kind: "grant", payload: cookie });
  const remove = host.ctx.credentials.deleteRecord;
  host.ctx.credentials.deleteRecord = async () => { throw new Error("simulated delete failure"); };
  const { login } = scriptedLogin();
  const manager = new LoginManager({ login, save: async () => {} });
  registerLoginRoutes(host.ctx, manager);
  const logout = () => host.routes.get(`${ROUTE_PREFIX}/account/logout`)!.fetch(new Request("http://host/logout", { method: "POST" }));
  await assert.rejects(logout, /simulated delete failure/);
  assert.equal(host.records.has(COOKIE_KEY), true);
  host.ctx.credentials.deleteRecord = remove;
  assert.equal((await logout()).status, 200);
  assert.equal(host.records.has(COOKIE_KEY), false);
});

test("停用后迟到的扫码结果不保存，也不删除已有凭据", async () => {
  const host = fakeHost({ cwd: "" });
  const old = { kind: "grant", payload: cookie };
  host.records.set(COOKIE_KEY, old);
  const { runs, login } = scriptedLogin();
  const manager = new LoginManager({ login, save: (value) => saveCookie(host.ctx.credentials, value) });
  const { id } = manager.start();
  await manager.dispose();
  runs[0].resolve({ ...cookie, DedeUserID: "84" });
  runs[0].progress({ state: "generating" });
  await tick();
  assert.equal(runs[0].signal.aborted, true);
  assert.equal(manager.poll(id), undefined);
  assert.deepEqual(host.records.get(COOKIE_KEY), old);
});

test("路由：未知会话 404，账号状态与登出不返回 Cookie 值", async () => {
  const host = fakeHost({ cwd: "" });
  const { login } = scriptedLogin();
  registerLoginRoutes(host.ctx, new LoginManager({ save: async () => {}, login }));
  const call = async (path: string, body?: unknown) => {
    const route = host.routes.get(`${ROUTE_PREFIX}${path}`)!;
    assert.deepEqual(route.methods, ["POST"]);
    const response = await route.fetch(new Request("http://host/x", { method: "POST", body: JSON.stringify(body ?? {}) }));
    return { status: response.status, text: await response.text() };
  };
  assert.equal((await call("/login/poll", { id: "missing" })).status, 404);
  assert.equal((await call("/login/cancel")).status, 404);
  assert.deepEqual(JSON.parse((await call("/account/status")).text), { loggedIn: false });
  host.records.set(COOKIE_KEY, { kind: "grant", payload: cookie });
  const status = await call("/account/status");
  assert.deepEqual(JSON.parse(status.text), { loggedIn: true, userId: "42" });
  assert.doesNotMatch(status.text, /secret-session|jct-value/);
  const started = JSON.parse((await call("/login/start")).text) as { id: string };
  assert.equal(typeof started.id, "string");
  assert.equal((await call("/login/poll", { id: started.id })).status, 200);
  await call("/account/logout");
  assert.equal(host.records.has(COOKIE_KEY), false);
});
