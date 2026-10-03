// Cuentas con Supabase Auth (supabase-js se carga desde un CDN en index.html).
// Si la librería no carga o falta la clave pública en config.js, Auth.enabled es false y la app funciona sin cuentas.
const Auth = (() => {
  const cfg = window.AUTH_CONFIG || {};
  const enabled = !!(window.supabase && cfg.url && cfg.anonKey && !cfg.anonKey.startsWith("PEGA"));
  let client = null;
  let session = null;
  const listeners = new Set();

  // Los mensajes de error de Supabase vienen en inglés; aquí se traducen los habituales.
  function friendly(error) {
    const text = String(error?.message || error || "");
    if (/invalid login credentials/i.test(text)) return "Correo o contraseña incorrectos.";
    if (/email not confirmed/i.test(text)) return "Primero confirma tu correo: te enviamos un enlace.";
    if (/already registered|already been registered/i.test(text)) return "Ese correo ya tiene una cuenta. Inicia sesión.";
    if (/password should be at least|weak password/i.test(text)) return "La contraseña es muy corta o muy débil (mínimo 6 caracteres).";
    if (/same as the old|different from the old/i.test(text)) return "La nueva contraseña debe ser distinta a la anterior.";
    if (/rate limit|too many|security purposes/i.test(text)) return "Demasiados intentos seguidos. Espera unos minutos.";
    if (/invalid format|unable to validate email/i.test(text)) return "El correo no es válido.";
    if (/failed to fetch|networkerror|load failed/i.test(text)) return "No hay conexión con el servidor de cuentas.";
    return text || "No se pudo completar la acción.";
  }

  let ready = Promise.resolve();
  if (enabled) {
    client = window.supabase.createClient(cfg.url, cfg.anonKey, {
      // PKCE: los enlaces del correo vuelven con ?code=… y no con #…, que es donde esta app guarda su ruta.
      auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    client.auth.onAuthStateChange((event, next) => {
      session = next;
      listeners.forEach((fn) => fn(event, next));
    });
    ready = client.auth
      .getSession()
      .then(({ data }) => {
        session = data.session;
      })
      .catch(() => {});
  }

  async function run(action) {
    if (!enabled) return { error: "Las cuentas todavía no están activadas." };
    try {
      const { data, error } = await action();
      return error ? { error: friendly(error) } : { data };
    } catch (e) {
      return { error: friendly(e) };
    }
  }

  return {
    enabled,
    ready,
    get token() {
      return session?.access_token || null;
    },
    get userId() {
      return session?.user?.id || null;
    },
    get email() {
      return session?.user?.email || null;
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    signIn: (email, password) => run(() => client.auth.signInWithPassword({ email, password })),
    async signUp(email, password) {
      const res = await run(() =>
        client.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }),
      );
      if (res.error) return res;
      // Con un correo que ya existe, Supabase responde "bien" pero sin identidades (para no revelar quién tiene cuenta).
      if (res.data.user && res.data.user.identities && res.data.user.identities.length === 0) {
        return { error: "Ese correo ya tiene una cuenta. Inicia sesión." };
      }
      return { data: res.data, confirm: !res.data.session };
    },
    signOut: () => run(() => client.auth.signOut()),
    resetPassword: (email) =>
      run(() => client.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname })),
    updatePassword: (password) => run(() => client.auth.updateUser({ password })),
  };
})();
