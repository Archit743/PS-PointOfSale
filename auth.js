/* Password gate for public deployments. The password itself never enters app storage. */
'use strict';
window.posAuthReady = new Promise(resolve => {
  const showLogin = () => {
    const box = document.createElement('div');
    box.id = 'pos-login';
    box.innerHTML = `<form><h1>Pradeep Sales POS</h1><p>Enter the shop access password to continue.</p><input type="password" autocomplete="current-password" placeholder="Access password" required><button type="submit">Sign in</button><div role="alert"></div></form>`;
    Object.assign(box.style, { position:'fixed', inset:'0', zIndex:'99999', background:'#f3f5f8', display:'grid', placeItems:'center', fontFamily:'system-ui,sans-serif' });
    const form = box.querySelector('form');
    Object.assign(form.style, { width:'min(360px,calc(100vw - 40px))', padding:'28px', background:'#fff', borderRadius:'14px', boxShadow:'0 8px 36px #17325c22', display:'grid', gap:'14px' });
    form.querySelector('button').style.cssText = 'padding:12px;border:0;border-radius:8px;background:#17325c;color:#fff;font-weight:700';
    form.querySelector('input').style.cssText = 'padding:12px;border:1px solid #ccd3df;border-radius:8px;font:inherit';
    form.onsubmit = async e => {
      e.preventDefault(); const err = form.querySelector('[role=alert]'); err.textContent = 'Signing in…';
      try {
        const r = await fetch('/api/auth/login', { method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ password:form.querySelector('input').value }) });
        if (!r.ok) throw new Error((await r.json()).error || 'Sign-in failed');
        localStorage.setItem('posTrusted','yes'); box.remove(); resolve();
      } catch (x) { err.textContent = x.message || 'Could not reach the server'; }
    };
    document.body.appendChild(box);
  };
  (async () => {
    try {
      const r = await fetch('/api/auth/session', { credentials:'same-origin' });
      if (r.ok || (!navigator.onLine && localStorage.getItem('posTrusted') === 'yes')) resolve();
      else showLogin();
    } catch { if (localStorage.getItem('posTrusted') === 'yes') resolve(); else showLogin(); }
  })();
});
