// #/login — first-run setup (password + name) or password login.
import { api } from '../api.js';
import { h, state, refreshAuth, navigate } from '../app.js';

export async function render(el) {
  let st = { setup: state.setup, authed: state.authed };
  try { st = await api.get('/api/auth/status'); } catch { /* offline; show login anyway */ }
  if (st.authed) {
    // the session outlived our cached state (stale boot, cookie set elsewhere):
    // sync it before leaving, or the router bounces straight back here
    try { await refreshAuth(); } catch { state.authed = true; state.me = st.me; }
    navigate('#/today');
    return;
  }

  const firstRun = !st.setup;
  const err = h('div', { class: 'err' });
  const nameInput = h('input', { type: 'text', placeholder: 'Your name', autocomplete: 'name' });
  const passInput = h('input', { type: 'password', placeholder: firstRun ? 'Choose a password' : 'Password', autocomplete: firstRun ? 'new-password' : 'current-password' });
  const pass2Input = h('input', { type: 'password', placeholder: 'Repeat password', autocomplete: 'new-password' });

  const form = h('form', { onsubmit: onSubmit },
    firstRun ? h('label', { class: 'field' }, 'Your name', nameInput) : null,
    h('label', { class: 'field' }, 'Password', passInput),
    firstRun ? h('label', { class: 'field' }, 'Repeat password', pass2Input) : null,
    err,
    h('button', { class: 'primary', type: 'submit', style: 'justify-content:center' },
      firstRun ? 'Create workspace' : 'Unlock'),
  );

  async function onSubmit(e) {
    e.preventDefault();
    err.textContent = '';
    const password = passInput.value;
    if (!password) { err.textContent = 'Password required.'; return; }
    try {
      if (firstRun) {
        if (password !== pass2Input.value) { err.textContent = 'Passwords do not match.'; return; }
        await api.post('/api/auth/setup', { password, my_name: nameInput.value.trim() || undefined });
      } else {
        await api.post('/api/auth/login', { password });
      }
      await refreshAuth();
      navigate('#/today');
    } catch (ex) {
      err.textContent = ex.status === 401 ? 'Wrong password.' :
        ex.status === 409 ? 'Already set up — reload and log in.' : (ex.message || 'Failed.');
    }
  }

  el.append(h('div', { class: 'login-wrap' },
    h('div', { class: 'card login-card' },
      h('div', { class: 'brand' },
        h('span', { html: '<svg viewBox="0 0 32 32" width="26" height="26"><circle cx="16" cy="16" r="13" fill="#F25C1F"/><circle cx="16" cy="16" r="5" fill="#0B0B0C"/></svg>', style: 'line-height:0' }),
        h('span', null, 'CRM', h('em', { style: 'font-style:normal;color:var(--accent)' }, '+'))),
      h('div', { class: 'lead' }, firstRun
        ? 'First run — set a password to protect your pipeline.'
        : 'Welcome back. Enter your password to continue.'),
      form,
    )));

  // an evicted cookie on a phone should cost typing, not an extra tap first
  setTimeout(() => { (firstRun ? nameInput : passInput).focus(); }, 30);
}
