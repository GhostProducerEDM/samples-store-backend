/* ── AUTH MODAL — Sonic Curator ───────────────────────────────────────────── */
(function () {
  const SUPABASE_URL = 'https://rxhcjwmlvftlqpkgjnwo.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ4aGNqd21sdmZ0bHFwa2dqbndvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMjY5NzUsImV4cCI6MjA4OTYwMjk3NX0.pyADAIhwVd0wKParzyiWpg2NJud6YDtrmAPtphRKauA';
  const API = window.location.hostname === 'localhost' ? 'http://localhost:3000' : 'https://samples-store-backend.onrender.com';

  // Use page's _supabase if available, else create own
  function getClient() {
    return window._supabase || (window._supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY));
  }

  /* ── INJECT HTML ── */
  const HTML = `
<div id="auth-modal-overlay" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.65);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);align-items:center;justify-content:center;padding:16px;">
  <!-- LOGIN -->
  <div id="auth-panel-login" class="auth-panel relative w-full max-w-md bg-surface-container-low rounded-[2rem] shadow-[0_20px_60px_rgba(0,0,0,0.85)] overflow-hidden border border-white/5" style="animation:authSlideUp 0.35s cubic-bezier(0.34,1.4,0.64,1);">
    <button class="absolute top-5 right-5 p-2 rounded-full hover:bg-surface-container-highest transition-colors text-on-surface-variant z-10" onclick="closeAuth()">
      <span class="material-symbols-outlined text-2xl">close</span>
    </button>
    <div class="px-10 pt-12 pb-10">
      <div class="flex flex-col items-center mb-8">
        <span class="material-symbols-outlined text-5xl text-primary mb-4" style="font-variation-settings:'FILL' 1;">graphic_eq</span>
        <h2 class="text-3xl font-black tracking-tighter text-on-surface mb-1">Sonic Curator</h2>
        <p class="text-on-surface-variant text-sm font-medium">Welcome Back</p>
      </div>
      <div class="space-y-3 mb-7">
        <button onclick="authWithGoogle()" class="w-full flex items-center justify-center gap-3 py-3.5 bg-surface-container-highest hover:bg-surface-bright transition-all rounded-xl text-sm font-semibold text-on-surface active:scale-[0.98]">
          <svg class="w-5 h-5" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="currentColor"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="currentColor"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="currentColor"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="currentColor"/></svg>
          Continue with Google
        </button>
      </div>
      <div class="relative flex items-center py-3 mb-4">
        <div class="flex-grow h-px bg-outline-variant/20"></div>
        <span class="mx-4 text-[10px] font-bold tracking-widest text-on-surface-variant uppercase">OR</span>
        <div class="flex-grow h-px bg-outline-variant/20"></div>
      </div>
      <div class="space-y-4">
        <div>
          <label class="text-[11px] font-bold uppercase tracking-widest text-on-surface-variant block mb-2 px-1">Email Address</label>
          <input id="auth-login-email" type="email" placeholder="name@example.com" class="w-full bg-surface-container-lowest border-none rounded-xl py-4 px-5 text-on-surface placeholder:text-on-surface-variant/40 focus:ring-2 focus:ring-primary/40 transition-all outline-none text-sm">
        </div>
        <div>
          <div class="flex justify-between items-center mb-2 px-1">
            <label class="text-[11px] font-bold uppercase tracking-widest text-on-surface-variant">Password</label>
            <button onclick="showPanel('forgot')" class="text-[11px] font-bold uppercase tracking-widest text-primary hover:text-primary/70 transition-colors">Forgot?</button>
          </div>
          <div class="relative">
            <input id="auth-login-password" type="password" placeholder="••••••••" class="w-full bg-surface-container-lowest border-none rounded-xl py-4 px-5 pr-12 text-on-surface placeholder:text-on-surface-variant/40 focus:ring-2 focus:ring-primary/40 transition-all outline-none text-sm">
            <button type="button" onclick="togglePwd('auth-login-password',this)" class="absolute right-4 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface">
              <span class="material-symbols-outlined text-xl">visibility</span>
            </button>
          </div>
        </div>
        <div id="auth-login-error" class="text-error text-xs px-1 min-h-[16px]"></div>
        <button onclick="doLogin()" class="w-full py-4 bg-gradient-to-br from-primary to-primary-container text-on-primary-container font-bold rounded-full shadow-lg shadow-primary/20 hover:brightness-110 active:scale-95 transition-all text-sm">
          Log In
        </button>
      </div>
      <div class="mt-8 text-center">
        <p class="text-sm text-on-surface-variant">Don't have an account? <button onclick="showPanel('register')" class="text-primary font-bold hover:underline underline-offset-4">Sign Up</button></p>
      </div>
    </div>
    <div class="h-1.5 w-full bg-gradient-to-r from-primary via-secondary to-primary-container"></div>
  </div>

  <!-- REGISTER -->
  <div id="auth-panel-register" class="auth-panel hidden relative w-full max-w-[480px] bg-surface-container-low rounded-xl shadow-[0_20px_60px_rgba(0,0,0,0.85)] overflow-hidden border border-white/5" style="animation:authSlideUp 0.35s cubic-bezier(0.34,1.4,0.64,1);">
    <div class="flex items-center justify-between px-8 pt-8 pb-4">
      <div>
        <span class="text-xs font-bold uppercase tracking-[0.2em] text-primary mb-1 block">Sonic Curator</span>
        <h2 class="text-2xl font-black tracking-tighter text-on-surface">Create Your Account</h2>
      </div>
      <button onclick="closeAuth()" class="w-10 h-10 flex items-center justify-center rounded-full bg-surface-container-highest text-on-surface-variant hover:text-on-surface transition-colors active:scale-95">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>
    <div class="px-8 pb-8 space-y-6">
      <button onclick="authWithGoogle()" class="w-full flex items-center justify-center gap-3 bg-surface-container-highest hover:bg-surface-bright h-12 rounded-full text-sm font-semibold transition-colors active:scale-95">
        <svg class="w-5 h-5" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="currentColor"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="currentColor"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="currentColor"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="currentColor"/></svg>
        Continue with Google
      </button>
      <div class="flex items-center gap-4">
        <div class="h-px flex-1 bg-outline-variant/20"></div>
        <span class="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold">OR EMAIL</span>
        <div class="h-px flex-1 bg-outline-variant/20"></div>
      </div>
      <div class="space-y-4">
        <div>
          <label class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant block mb-2 ml-1">Email Address</label>
          <div class="relative">
            <span class="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant text-xl">mail</span>
            <input id="auth-reg-email" type="email" placeholder="curator@sonicwave.com" class="w-full h-14 bg-surface-container-lowest border-none rounded-xl pl-12 pr-4 text-on-surface placeholder:text-on-surface-variant/40 focus:ring-2 focus:ring-primary/40 transition-all outline-none text-sm">
          </div>
        </div>
        <div>
          <label class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant block mb-2 ml-1">Password</label>
          <div class="relative">
            <span class="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant text-xl">lock</span>
            <input id="auth-reg-password" type="password" placeholder="••••••••••••" class="w-full h-14 bg-surface-container-lowest border-none rounded-xl pl-12 pr-12 text-on-surface placeholder:text-on-surface-variant/40 focus:ring-2 focus:ring-primary/40 transition-all outline-none text-sm">
            <button type="button" onclick="togglePwd('auth-reg-password',this)" class="absolute right-4 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface">
              <span class="material-symbols-outlined text-xl">visibility</span>
            </button>
          </div>
          <div class="mt-2 px-1 flex justify-between text-[10px]">
            <span class="text-on-surface-variant">8+ characters required</span>
          </div>
        </div>
        <div id="auth-reg-error" class="text-error text-xs px-1 min-h-[16px]"></div>
        <div id="auth-reg-success" class="hidden bg-secondary/10 text-secondary text-sm px-4 py-3 rounded-xl font-medium">Check your email to confirm your account!</div>
        <button onclick="doRegister()" class="w-full h-14 bg-gradient-to-br from-primary to-primary-container text-on-primary-container font-black tracking-tight rounded-full text-base shadow-[0_8px_24px_rgba(179,197,255,0.25)] hover:brightness-110 active:scale-95 transition-all">
          Sign Up
        </button>
      </div>
      <div class="text-center pt-1">
        <p class="text-sm text-on-surface-variant">Already have an account? <button onclick="showPanel('login')" class="text-primary font-bold hover:underline ml-1">Log In</button></p>
      </div>
    </div>
    <div class="h-1.5 w-full bg-gradient-to-r from-primary via-secondary to-primary-container opacity-40"></div>
  </div>

  <!-- FORGOT PASSWORD -->
  <div id="auth-panel-forgot" class="auth-panel hidden relative w-full max-w-lg bg-surface-container-low rounded-3xl shadow-[0_20px_40px_rgba(0,0,0,0.7)] overflow-hidden border border-white/5" style="animation:authSlideUp 0.35s cubic-bezier(0.34,1.4,0.64,1);">
    <div class="flex items-center justify-between p-6">
      <button onclick="showPanel('login')" class="flex items-center gap-2 text-on-surface-variant hover:text-on-surface transition-colors text-sm font-medium">
        <span class="material-symbols-outlined text-xl">arrow_back</span>
        Back to login
      </button>
      <div class="w-8 h-8 rounded-full bg-surface-container-highest flex items-center justify-center">
        <span class="material-symbols-outlined text-lg text-primary">lock_reset</span>
      </div>
    </div>
    <div class="px-8 pb-12 pt-2">
      <h2 class="text-3xl font-bold tracking-tight text-on-surface mb-2">Reset Your Password</h2>
      <p class="text-on-surface-variant text-base leading-relaxed mb-10 max-w-[340px]">Enter your email address and we'll send you a link to reset your password.</p>
      <div class="space-y-3 mb-8">
        <label class="text-[11px] font-bold uppercase tracking-[0.15em] text-on-surface-variant block px-1">Email Address</label>
        <input id="auth-forgot-email" type="email" placeholder="name@studio.com" class="w-full bg-surface-container-lowest border-none ring-1 ring-outline-variant/20 rounded-xl py-4 px-5 text-on-surface placeholder:text-on-surface-variant/40 focus:ring-2 focus:ring-primary/40 transition-all outline-none text-sm">
      </div>
      <div id="auth-forgot-error" class="text-error text-xs px-1 mb-3 min-h-[16px]"></div>
      <div id="auth-forgot-success" class="hidden bg-secondary/10 text-secondary text-sm px-4 py-3 rounded-xl font-medium mb-4">Reset link sent! Check your inbox.</div>
      <button onclick="doForgot()" class="w-full bg-gradient-to-r from-primary to-primary-container text-on-primary-container font-bold py-4 rounded-full flex items-center justify-center gap-3 active:scale-95 transition-all shadow-lg shadow-primary/10 text-sm">
        Send Reset Link
        <span class="material-symbols-outlined text-xl">send</span>
      </button>
      <div class="mt-10 pt-8 border-t border-outline-variant/10 text-center">
        <p class="text-sm text-on-surface-variant">Still having trouble? <a href="mailto:support@gpesamplesstore.com" class="text-primary font-medium hover:underline ml-1">Contact Support</a></p>
      </div>
    </div>
    <div class="h-1.5 w-full bg-gradient-to-r from-primary via-secondary to-primary-container opacity-50"></div>
  </div>
</div>
<style>
@keyframes authSlideUp { from { transform: translateY(32px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
#auth-modal-overlay.open { display: flex !important; }
.auth-panel.hidden { display: none !important; }
</style>`;

  // Inject on DOM ready
  function inject() {
    document.body.insertAdjacentHTML('beforeend', HTML);
    // Close on backdrop click
    document.getElementById('auth-modal-overlay').addEventListener('click', function(e) {
      if (e.target === this) closeAuth();
    });
    // Escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeAuth();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();

  /* ── PUBLIC API ── */
  let _pendingCallback = null;

  window.openAuth = function(callback, panel) {
    _pendingCallback = callback || null;
    showPanel(panel || 'login');
    document.getElementById('auth-modal-overlay').classList.add('open');
    setTimeout(() => {
      const el = document.getElementById(panel === 'register' ? 'auth-reg-email' : 'auth-login-email');
      if (el) el.focus();
    }, 100);
  };

  window.closeAuth = function() {
    document.getElementById('auth-modal-overlay').classList.remove('open');
    clearErrors();
  };

  window.showPanel = function(name) {
    ['login', 'register', 'forgot'].forEach(p => {
      const el = document.getElementById('auth-panel-' + p);
      if (el) el.classList.toggle('hidden', p !== name);
    });
    clearErrors();
  };

  window.togglePwd = function(inputId, btn) {
    const input = document.getElementById(inputId);
    const icon = btn.querySelector('.material-symbols-outlined');
    if (input.type === 'password') { input.type = 'text'; if(icon) icon.textContent = 'visibility_off'; }
    else { input.type = 'password'; if(icon) icon.textContent = 'visibility'; }
  };

  window.authWithGoogle = async function() {
    const sb = getClient();
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.href }
    });
    if (error) setError('login', error.message);
  };

  window.doLogin = async function() {
    const email = document.getElementById('auth-login-email').value.trim();
    const password = document.getElementById('auth-login-password').value;
    if (!email || !password) { setError('login', 'Please enter email and password'); return; }
    const btn = document.querySelector('#auth-panel-login button[onclick="doLogin()"]');
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    const { data, error } = await getClient().auth.signInWithPassword({ email, password });
    if (btn) { btn.disabled = false; btn.textContent = 'Log In'; }
    if (error) { setError('login', 'Invalid email or password'); return; }
    onAuthSuccess(data.user);
  };

  window.doRegister = async function() {
    const email = document.getElementById('auth-reg-email').value.trim();
    const password = document.getElementById('auth-reg-password').value;
    if (!email || !password) { setError('register', 'Please fill in all fields'); return; }
    if (password.length < 8) { setError('register', 'Password must be at least 8 characters'); return; }
    const btn = document.querySelector('#auth-panel-register button[onclick="doRegister()"]');
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    const { data, error } = await getClient().auth.signUp({ email, password });
    if (btn) { btn.disabled = false; btn.textContent = 'Sign Up'; }
    if (error) { setError('register', error.message); return; }
    document.getElementById('auth-reg-success').classList.remove('hidden');
    // If session exists immediately (email confirm disabled), log in
    if (data.session) onAuthSuccess(data.user);
  };

  window.doForgot = async function() {
    const email = document.getElementById('auth-forgot-email').value.trim();
    if (!email) { setError('forgot', 'Please enter your email'); return; }
    const btn = document.querySelector('#auth-panel-forgot button[onclick="doForgot()"]');
    if (btn) { btn.disabled = true; }
    const redirectBase = window.location.hostname === 'localhost'
      ? 'http://localhost:3001'
      : window.location.origin;
    const { error } = await getClient().auth.resetPasswordForEmail(email, {
      redirectTo: redirectBase + '/browse'
    });
    if (btn) { btn.disabled = false; }
    if (error) { setError('forgot', error.message); return; }
    document.getElementById('auth-forgot-success').classList.remove('hidden');
    document.getElementById('auth-forgot-error').textContent = '';
  };

  /* ── INTERNAL ── */
  async function onAuthSuccess(user) {
    closeAuth();
    // Ensure user record exists
    try {
      const { data: { session } } = await getClient().auth.getSession();
      if (session) {
        await fetch(API + '/api/ensure-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token }
        });
      }
    } catch(e) {}
    // Notify page
    if (typeof window.onUserLoggedIn === 'function') window.onUserLoggedIn(user);
    if (_pendingCallback) { _pendingCallback(user); _pendingCallback = null; }
  }

  function setError(panel, msg) {
    const el = document.getElementById('auth-' + panel + '-error');
    if (el) el.textContent = msg;
  }

  function clearErrors() {
    ['login', 'register', 'forgot'].forEach(p => {
      const el = document.getElementById('auth-' + p + '-error');
      if (el) el.textContent = '';
    });
    const s = document.getElementById('auth-reg-success');
    if (s) s.classList.add('hidden');
    const fs = document.getElementById('auth-forgot-success');
    if (fs) fs.classList.add('hidden');
  }
})();
