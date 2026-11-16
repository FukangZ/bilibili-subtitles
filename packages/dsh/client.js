// dsh Web 客户端插件：扫码登录卡片、账号状态与配置表单。
// 手写 ESM 外的 ModuleLoader 模块，不经过打包器；只使用宿主提供的 React。
window.__ModuleLoader__.load({
  id: '@fukangz/dsh-bilibili-subtitles/client',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PACKAGE = '@fukangz/dsh-bilibili-subtitles';
    const ENTRY_ID = 'bilibili-subtitles';
    const API = 'api/bilibili-subtitles';
    const POLL_MS = 2000;
    const FINAL = new Set(['success', 'error', 'cancelled']);

    const overlay = {
      open: false,
      listeners: new Set(),
      set(value) { overlay.open = value; overlay.listeners.forEach((fn) => fn()); },
      subscribe(fn) { overlay.listeners.add(fn); return () => overlay.listeners.delete(fn); },
    };

    // 账号状态变更（登录成功/退出）后通知设置页刷新。
    const account = {
      version: 0,
      listeners: new Set(),
      bump() { account.version += 1; account.listeners.forEach((fn) => fn()); },
      subscribe(fn) { account.listeners.add(fn); return () => account.listeners.delete(fn); },
    };

    async function post(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const data = await response.json().catch(() => undefined);
      if (!response.ok) {
        const error = new Error(data?.error ?? `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return data;
    }

    const color = {
      label: 'var(--dsw-alias-label-primary, inherit)',
      secondary: 'var(--dsw-alias-label-secondary, #666)',
      border: 'var(--dsw-alias-border-l2, #ddd)',
      layer: 'var(--dsw-alias-bg-layer-1, #fff)',
      error: 'var(--dsw-alias-state-error-primary, #d33)',
      primary: 'var(--dsw-alias-button-primary-fill, #00a1d6)',
      onPrimary: 'var(--dsw-alias-label-primary-foreground, #fff)',
      mask: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.35))',
    };

    function QrSvg({ rows }) {
      const margin = 4;
      let d = '';
      rows.forEach((row, r) => {
        for (let c = 0; c < row.length; c += 1) if (row[c] === '1') d += `M${c + margin} ${r + margin}h1v1h-1z`;
      });
      const size = rows.length + margin * 2;
      return h('svg', {
        viewBox: `0 0 ${size} ${size}`, width: 232, height: 232, shapeRendering: 'crispEdges',
        role: 'img', 'aria-label': '哔哩哔哩登录二维码', 'data-bili-qr': 'true',
        style: { display: 'block', background: '#fff', borderRadius: 8 },
      }, h('rect', { width: size, height: size, fill: '#fff' }), h('path', { d, fill: '#000' }));
    }

    const STATUS_TEXT = {
      starting: '正在连接…',
      generating: '正在生成二维码…',
      waiting: '请使用哔哩哔哩 App 扫码',
      scanned: '已扫码，请在手机上确认登录',
      saving: '正在保存登录凭据，无法取消；请等待保存完成，需要退出时可在设置页退出登录',
      success: '登录成功，Cookie 已保存到 dsh 凭据存储',
      cancelled: '已取消',
      error: '登录失败',
    };

    function button(label, onClick, options = {}) {
      return h('button', {
        type: 'button', onClick, disabled: options.disabled,
        style: {
          padding: '6px 14px', borderRadius: 6, cursor: options.disabled ? 'default' : 'pointer',
          border: options.primary ? 'none' : `1px solid ${color.border}`,
          background: options.primary ? color.primary : 'transparent',
          color: options.primary ? color.onPrimary : color.label,
          opacity: options.disabled ? 0.6 : 1,
        },
      }, label);
    }

    function LoginPanel({ onDone }) {
      const [state, setState] = React.useState({ state: 'starting' });
      const [attempt, setAttempt] = React.useState(0);
      const [sessionId, setSessionId] = React.useState(null);
      const [cancelling, setCancelling] = React.useState(false);
      const [cancelError, setCancelError] = React.useState('');
      React.useEffect(() => {
        let alive = true;
        let timer;
        let id;
        const tick = async () => {
          try {
            const data = await post('/login/poll', { id });
            if (!alive) return;
            setState((current) => current.state === 'saving' && !FINAL.has(data.status.state) ? current : data.status);
            if (FINAL.has(data.status.state)) {
              if (data.status.state === 'success') account.bump();
              return;
            }
          } catch (error) {
            if (!alive) return;
            setState({ state: 'error', message: error.status === 404 ? '登录会话已失效' : String(error.message) });
            return;
          }
          timer = setTimeout(tick, POLL_MS);
        };
        (async () => {
          try {
            const started = await post('/login/start');
            if (!alive) { post('/login/cancel', { id: started.id }).catch(() => {}); return; }
            id = started.id;
            setSessionId(id);
            setState(started.status);
            timer = setTimeout(tick, POLL_MS);
          } catch (error) {
            if (alive) setState({ state: 'error', message: String(error.message) });
          }
        })();
        return () => {
          alive = false;
          clearTimeout(timer);
          if (id) post('/login/cancel', { id }).catch(() => {});
        };
      }, [attempt]);

      const done = FINAL.has(state.state);
      const close = async () => {
        if (done) { onDone(); return; }
        if (!sessionId || cancelling || state.state === 'saving') return;
        setCancelling(true);
        setCancelError('');
        try {
          await post('/login/cancel', { id: sessionId });
          account.bump();
          onDone();
        } catch (error) {
          if (error.status === 409 && error.message === 'LOGIN_SAVING') {
            setState((current) => FINAL.has(current.state) ? current : { state: 'saving' });
          } else if (error.status === 404) {
            account.bump();
            onDone();
          } else {
            setCancelError('未能确认取消，请重试或等待登录状态更新');
          }
        } finally {
          setCancelling(false);
        }
      };
      const regenerate = () => {
        setSessionId(null);
        setState({ state: 'starting' });
        setCancelError('');
        setAttempt((n) => n + 1);
      };
      return h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, color: color.label } },
        state.rows ? h(QrSvg, { rows: state.rows }) : null,
        h('div', { style: { color: state.state === 'error' ? color.error : color.label } },
          STATUS_TEXT[state.state] ?? state.state, state.message ? `：${state.message}` : ''),
        cancelError ? h('div', { role: 'alert', style: { color: color.error } }, cancelError) : null,
        state.expiresAt && !done ? h('div', { style: { color: color.secondary, fontSize: 12 } },
          `二维码将于 ${new Date(state.expiresAt).toLocaleTimeString()} 过期`) : null,
        h('div', { style: { display: 'flex', gap: 8 } },
          done && state.state !== 'success' ? button('重新生成', regenerate, { primary: true, disabled: cancelling }) : null,
          button(done ? '关闭' : state.state === 'saving' ? '保存中…' : cancelling ? '取消中…' : '取消', close, {
            disabled: cancelling || (!done && (!sessionId || state.state === 'saving')),
          })));
    }

    function AccountSection() {
      const version = React.useSyncExternalStore(account.subscribe, () => account.version);
      const [status, setStatus] = React.useState({ loading: true });
      const [busy, setBusy] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        post('/account/status')
          .then((data) => { if (alive) setStatus(data); })
          .catch((error) => { if (alive) setStatus({ error: String(error.message) }); });
        return () => { alive = false; };
      }, [version]);
      const logout = async () => {
        setBusy(true);
        try { await post('/account/logout'); } finally { setBusy(false); account.bump(); }
      };
      let text = '正在读取登录状态…';
      if (status.error) text = `读取登录状态失败：${status.error}`;
      else if (!status.loading) text = status.loggedIn ? `已登录（DedeUserID ${status.userId ?? '未知'}）` : '未登录';
      return h('section', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('h3', { style: { margin: 0, fontSize: 15 } }, 'B 站账号'),
        h('div', { style: { color: status.error ? color.error : color.label } }, text),
        h('div', { style: { display: 'flex', gap: 8 } },
          button(status.loggedIn ? '重新扫码登录' : '扫码登录', () => overlay.set(true), { primary: true }),
          status.loggedIn ? button('退出登录', logout, { disabled: busy }) : null));
    }

    const FIELDS = [
      { key: 'provider', label: '润色模型提供方', hint: '留空则跟随会话模型；须与模型同时填写', type: 'text' },
      { key: 'model', label: '润色模型', hint: '留空则跟随会话模型', type: 'text' },
      { key: 'reasoningEffort', label: '思考强度', hint: '仅在指定模型时使用，如 high', type: 'text' },
      { key: 'timeoutMs', label: '单阶段超时（毫秒）', hint: '默认 300000，最小 1000', type: 'number' },
    ];

    function useForm(configForms) {
      const form = React.useMemo(() => configForms?.get?.(ENTRY_ID), [configForms]);
      const subscribe = React.useCallback((fn) => (form ? form.subscribe(fn) : () => {}), [form]);
      const snapshot = React.useSyncExternalStore(subscribe, () => form?.getSnapshot());
      return { form, snapshot };
    }

    function FieldRow({ field, form, snapshot }) {
      const user = snapshot?.user && typeof snapshot.user === 'object' ? snapshot.user : {};
      const current = user[field.key] ?? snapshot?.value?.[field.key];
      const [draft, setDraft] = React.useState(current === undefined ? '' : String(current));
      const [message, setMessage] = React.useState('');
      React.useEffect(() => { setDraft(current === undefined ? '' : String(current)); }, [current]);
      const writable = Boolean(form && snapshot?.status === 'ready' && snapshot.writable);
      const save = async () => {
        const text = draft.trim();
        if (text === (current === undefined ? '' : String(current))) return;
        let ok;
        if (!text) ok = await form.unset(field.key);
        else if (field.type === 'number') {
          const value = Number(text);
          if (!Number.isInteger(value) || value < 1000) { setMessage('请输入不小于 1000 的整数'); return; }
          ok = await form.set(field.key, value);
        } else ok = await form.set(field.key, text);
        setMessage(ok ? '已保存' : '保存失败');
      };
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('span', null, field.label),
        h('input', {
          type: field.type === 'number' ? 'number' : 'text', value: draft, disabled: !writable,
          placeholder: field.hint,
          onChange: (event) => { setDraft(event.target.value); setMessage(''); },
          onBlur: () => { save().catch((error) => setMessage(`保存失败：${error.message}`)); },
          onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur(); },
          style: { padding: '6px 8px', borderRadius: 6, border: `1px solid ${color.border}`, background: color.layer, color: color.label },
        }),
        h('span', { style: { color: message && message !== '已保存' ? color.error : color.secondary, fontSize: 12 } }, message || field.hint));
    }

    function ConfigSection({ configForms }) {
      const { form, snapshot } = useForm(configForms);
      let note = null;
      if (!form) note = '当前 dsh 版本未提供配置表单服务。';
      else if (snapshot?.status === 'loading') note = '正在读取配置…';
      else if (snapshot?.status === 'unavailable') note = '配置暂不可用，请确认插件已启用。';
      else if (snapshot && !snapshot.writable) note = '配置为只读。';
      return h('section', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('h3', { style: { margin: 0, fontSize: 15 } }, '设置'),
        note ? h('div', { style: { color: color.secondary } }, note) : null,
        ...FIELDS.map((field) => h(FieldRow, { key: field.key, field, form, snapshot })));
    }

    function makeConfigPage(configForms) {
      return function ConfigPage(props) {
        if (props?.view === 'summary') return '下载并润色 B 站中文字幕';
        return h('div', { 'data-bili-config': 'true', style: { display: 'flex', flexDirection: 'column', gap: 20, color: color.label } },
          h(AccountSection), h(ConfigSection, { configForms }));
      };
    }

    function Overlay() {
      const open = React.useSyncExternalStore(overlay.subscribe, () => overlay.open);
      if (!open) return null;
      return h('div', {
        'data-bili-overlay': 'true',
        style: { position: 'fixed', inset: 0, background: color.mask, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
      }, h('div', {
        role: 'dialog', 'aria-label': 'B 站扫码登录',
        style: { background: color.layer, color: color.label, borderRadius: 12, padding: 20, minWidth: 300, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' },
      }, h('div', { style: { fontWeight: 600, marginBottom: 12 } }, 'B 站扫码登录'),
      h(LoginPanel, { onDone: () => overlay.set(false) })));
    }

    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        const ConfigPage = makeConfigPage(ctx.configForms);
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: PACKAGE,
        }, ConfigPage));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'bilibili-subtitles-login',
        }, Overlay));
      },
    };
  },
});
