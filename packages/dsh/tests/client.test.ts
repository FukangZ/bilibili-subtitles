import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

type Element = { type: unknown; props: Record<string, unknown>; children: unknown[] };
type Component = (props: Record<string, unknown>) => Element | string | null;

function findButton(node: unknown, label: string): Element | undefined {
  if (node === null || typeof node !== "object" || !("type" in node)) return;
  const element = node as Element;
  if (typeof element.type === "function") return findButton(element.type(element.props), label);
  if (element.type === "button" && element.children.includes(label)) return element;
  for (const child of element.children) {
    const button = findButton(child, label);
    if (button) return button;
  }
}

test("Web 客户端无需命令服务，配置页可打开和取消扫码登录", async () => {
  type Plugin = { inject: string[]; apply(ctx: object): void };
  type Registration = { id: string; factory(require: (id: string) => unknown): Plugin };
  let registration: Registration | undefined;
  let cancelConflict = false;
  const requests: string[] = [];
  const source = await readFile(new URL("../client.js", import.meta.url), "utf8");
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value: Registration) { registration = value; } } },
    fetch: async (url: string) => {
      requests.push(url);
      return {
        ok: !cancelConflict, status: cancelConflict ? 409 : 200,
        json: async () => cancelConflict ? { error: "LOGIN_SAVING" } : { ok: true },
      };
    },
  });
  assert.ok(registration);
  assert.equal(registration.id.replace(/\/client$/, ""), "@fukangz/dsh-bilibili-subtitles");
  let loginState = { state: "starting" };
  const plugin = registration.factory((id) => {
    assert.equal(id, "react");
    return {
      createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element {
        return { type, props: props ?? {}, children };
      },
      useState(initial: unknown) {
        if (typeof initial === "object" && initial !== null && "state" in initial) {
          return [loginState, (value: typeof loginState | ((current: typeof loginState) => typeof loginState)) => {
            loginState = typeof value === "function" ? value(loginState) : value;
          }];
        }
        return [initial === null ? "session-1" : initial, () => {}];
      },
      useEffect() {},
      useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) { return snapshot(); },
      useMemo(factory: () => unknown) { return factory(); },
      useCallback(callback: unknown) { return callback; },
    };
  });
  assert.deepEqual(Array.from(plugin.inject).sort(), ["configForms", "slots"]);
  const components = new Map<string, Component>();
  const disposers: (() => void)[] = [];
  const services: Record<string, unknown> = {
    configForms: { get() {} },
    slots: {
      inject(_name: string, callback: () => () => void) { disposers.push(callback()); },
      register(options: { name: string }, component: Component) {
        assert.equal(typeof component, "function");
        components.set(options.name, component);
        return () => { components.delete(options.name); };
      },
    },
  };
  // 不提供命令服务；未知服务和未声明的注入均立即失败。
  const ctx = new Proxy({}, {
    get(_target, key) {
      assert.equal(typeof key, "string");
      assert.ok(typeof key === "string" && key in services, `unexpected service: ${String(key)}`);
      assert.ok(plugin.inject.includes(key), `cannot get property "${key}" without inject`);
      return services[key];
    },
  });
  plugin.apply(ctx);
  assert.deepEqual([...components.keys()], ["plugins.bundle.config", "shell.overlay"]);
  const configPage = components.get("plugins.bundle.config")!;
  const overlay = components.get("shell.overlay")!;
  assert.equal(configPage({ view: "summary" }), "下载并润色 B 站中文字幕");
  assert.equal(overlay({}), null);
  const login = findButton(configPage({}), "扫码登录");
  assert.ok(login);
  assert.ok(typeof login.props.onClick === "function");
  login.props.onClick();
  assert.ok(overlay({}));
  const backdrop = overlay({});
  assert.ok(backdrop && typeof backdrop !== "string");
  assert.equal(backdrop.props.onClick, undefined, "遮罩不能绕过服务端取消确认");
  const cancel = findButton(overlay({}), "取消");
  assert.ok(cancel);
  assert.ok(typeof cancel.props.onClick === "function");
  await cancel.props.onClick();
  assert.equal(overlay({}), null);
  assert.equal(requests.at(-1), "api/bilibili-subtitles/login/cancel");
  login.props.onClick();
  cancelConflict = true;
  const staleCancel = findButton(overlay({}), "取消");
  assert.ok(staleCancel && typeof staleCancel.props.onClick === "function");
  await staleCancel.props.onClick();
  assert.ok(overlay({}));
  assert.equal(loginState.state, "saving");
  assert.equal(findButton(overlay({}), "取消"), undefined);
  const saving = findButton(overlay({}), "保存中…");
  assert.ok(saving);
  assert.equal(saving.props.disabled, true);
  loginState = { state: "success" };
  const close = findButton(overlay({}), "关闭");
  assert.ok(close);
  assert.ok(typeof close.props.onClick === "function");
  await close.props.onClick();
  assert.equal(overlay({}), null);
  for (const dispose of disposers.reverse()) dispose();
  assert.equal(components.size, 0);
});
