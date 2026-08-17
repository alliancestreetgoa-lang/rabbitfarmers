'use client';

import { useState } from 'react';
import { Eye, EyeOff, ArrowLeft, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

/**
 * Sign in.
 *
 * The layout is the one that was asked for — split screen, image left, form
 * right, black submit, rounded inputs, a password reveal. Three controls from
 * that design are not here, and each is missing for a reason in this codebase
 * rather than to save work:
 *
 *   CONTINUE WITH GOOGLE / GITHUB. There is no OAuth. docs/06 chose "email +
 *   password, no verification" deliberately, and /auth/signin accepts an email
 *   or a phone with a password and nothing else. A button that opens no provider
 *   is worse than no button: it is the one a farmer tries first.
 *
 *   FORGOT PASSWORD. There is no self-serve reset, and this is not an oversight
 *   either — with no verified email there is no address to trust a reset link
 *   to. `POST /admin/farms/:id/reset_password` is the only way out of a lockout,
 *   run by a person, and its own comment says so: "There is no email
 *   verification, so there is no reset link to send." So the line under the form
 *   says what actually happens instead of pretending a link exists.
 *
 *   REMEMBER ME is here and it is real: it chooses localStorage over
 *   sessionStorage, which is the difference between surviving a browser restart
 *   and not. The server issues a 30-day session either way.
 */

const BRAND_IMAGE =
  'https://images.unsplash.com/photo-1585110396000-c9ffd4e4b308?auto=format&fit=crop&w=1400&q=70';

export function LoginPage() {
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    rememberMe: true,
  });

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      /*
       * The field is `email`, not `identifier`. /auth/signin reads `email` or
       * `phone` and looks the account up through auth_lookup_by_email; anything
       * else arrives as an empty string and comes back "Email or password is
       * incorrect", which reads exactly like a wrong password.
       */
      const res = await fetch('/api/auth/signin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: formData.email.trim(),
          password: formData.password,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? 'Could not sign in');
        return;
      }
      // Where "remember me" actually lands. sessionStorage dies with the tab.
      const store = formData.rememberMe ? window.localStorage : window.sessionStorage;
      store.setItem('rf.session', JSON.stringify(body));
      navigate('/dashboard');
    } catch {
      setError('No connection. Signing in needs internet.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen w-screen bg-gradient-to-br from-slate-900 via-farm-accent-deep to-slate-800">
      {/* Left panel — the picture */}
      <div className="relative hidden flex-1 overflow-hidden lg:block">
        <div className="absolute top-6 left-6 z-10">
          <button
            onClick={() => navigate('/')}
            aria-label="Back"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-black/25 backdrop-blur-sm transition-all hover:bg-black/40"
          >
            <ArrowLeft className="h-5 w-5 text-white" />
          </button>
        </div>

        <img
          src={BRAND_IMAGE}
          alt="A white rabbit on open ground"
          className="absolute inset-0 h-full w-full object-cover"
        />
        {/* Scrim, so the wordmark stays legible whatever the photo does. */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent" />

        <div className="absolute bottom-10 left-10 right-10 text-white">
          <p className="font-display text-4xl leading-tight">
            Every doe, every day,
            <br />
            accounted for.
          </p>
          <p className="mt-4 text-sm tracking-[0.18em] text-white/70 uppercase">
            Healthy rabbits · Better farms · Brighter future
          </p>
        </div>
      </div>

      {/* Right panel — the form */}
      <div className="flex flex-1 items-center justify-center bg-white">
        <div className="w-full max-w-md p-8">
          <div className="mb-8">
            <p className="mb-6 font-display text-2xl">
              <span className="text-farm-accent">rabbit</span>
              <span className="text-[#5a3a22]">farmers</span>
            </p>
            <h1 className="mb-2 text-3xl font-bold text-gray-900">Welcome back</h1>
            <p className="text-gray-600">
              Don&apos;t have an account?{' '}
              <button
                onClick={() => navigate('/signup')}
                className="font-medium text-farm-accent hover:underline"
              >
                Sign up
              </button>
              {' — it’s free.'}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="email" className="mb-2 block text-sm font-medium text-gray-700">
                Email address
              </label>
              <input
                id="email"
                type="email"
                name="email"
                autoComplete="email"
                value={formData.email}
                onChange={handleInputChange}
                placeholder="you@example.com"
                className="w-full rounded-xl border border-gray-300 px-4 py-3 outline-none focus:ring-2 focus:ring-farm-accent"
                required
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-2 block text-sm font-medium text-gray-700">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  autoComplete="current-password"
                  value={formData.password}
                  onChange={handleInputChange}
                  placeholder="Your password"
                  className="w-full rounded-xl border border-gray-300 px-4 py-3 pr-12 outline-none focus:ring-2 focus:ring-farm-accent"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full p-1 hover:bg-gray-100"
                >
                  {showPassword ? (
                    <EyeOff className="h-5 w-5 text-gray-500" />
                  ) : (
                    <Eye className="h-5 w-5 text-gray-500" />
                  )}
                </button>
              </div>
            </div>

            <label className="flex items-center space-x-2 text-sm text-gray-600">
              <input
                type="checkbox"
                name="rememberMe"
                checked={formData.rememberMe}
                onChange={handleInputChange}
                className="h-4 w-4 rounded border-gray-300 accent-farm-accent"
              />
              <span>Keep me signed in on this computer</span>
            </label>

            {error && (
              <p
                role="alert"
                className="rounded-xl bg-farm-crit-soft px-4 py-3 text-sm font-medium text-farm-crit"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-black px-4 py-3 font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-60"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy ? 'Signing in…' : 'Sign in'}
            </button>

            {/*
              Where "Forgot password?" was. There is no reset link to send, so
              this says what really happens rather than opening a dead end.
            */}
            <p className="border-t border-gray-200 pt-5 text-center text-sm text-gray-500">
              Forgotten your password? A farm owner can reset it for a farm hand
              from <span className="font-medium text-gray-700">Team</span>. Owners
              need to ask support — there is no reset email, because no email is
              verified.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
