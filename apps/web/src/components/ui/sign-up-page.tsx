'use client';

import { useState } from 'react';
import { Eye, EyeOff, ArrowLeft, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { BRAND_IMAGE, BRAND_TAGLINE } from '@/lib/brand';
import { saveSession } from '@/lib/api';

/**
 * Create a farm. Free, instant, no card, no verification step.
 *
 * Every field is compulsory, the address included — a product decision made
 * deliberately: the platform exists to collect farm data, and a farm that
 * cannot be placed on a map is a farm the data cannot say much about. The
 * server enforces this in validateSignup, so the phone app obeys the same rule;
 * this form marking fields required is a courtesy, not the enforcement.
 *
 * Errors are rendered per field. /auth/signup answers 400 with
 * `detail: { field: message }` and 409 with `detail: { field }` for a duplicate,
 * and that 409 distinction exists because a farmer whose PHONE was taken used to
 * be told their EMAIL was — so they would change the email, try again, and read
 * the same sentence, with nothing pointing at the field that was actually wrong.
 */

type Errors = Record<string, string>;

export function SignUpPage() {
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [form, setForm] = useState({
    farm_name: '',
    full_name: '',
    email: '',
    phone: '',
    password: '',
    address_line: '',
    city: '',
    state: '',
    pincode: '',
  });

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
    // Clear this field's error as soon as it is touched. Leaving it up while
    // somebody fixes it is how a form feels broken.
    setErrors((prev) => (prev[name] ? { ...prev, [name]: '' } : prev));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setErrors({});
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        if (res.status === 400 && body?.detail && typeof body.detail === 'object') {
          setErrors(body.detail as Errors);
          setMessage(null);
        } else if (res.status === 409) {
          // The server names the field. Put the message on it rather than in a
          // banner that does not say which of the two is the problem.
          const field = body?.detail?.field;
          if (field) setErrors({ [field]: body.error });
          else setMessage(body?.error ?? 'That account already exists');
        } else {
          setMessage(body?.error ?? 'Could not create the farm');
        }
        return;
      }

      // One login for the whole site: this also signs the full app in.
      saveSession(body, true);
      navigate('/dashboard');
    } catch {
      setMessage('No connection. Creating a farm needs internet.');
    } finally {
      setBusy(false);
    }
  };

  const field = (
    name: keyof typeof form,
    label: string,
    props: React.InputHTMLAttributes<HTMLInputElement> = {},
  ) => (
    <div>
      <label htmlFor={name} className="mb-2 block text-sm font-medium text-gray-700">
        {label}
      </label>
      <input
        id={name}
        name={name}
        value={form[name]}
        onChange={onChange}
        aria-invalid={!!errors[name]}
        className={`w-full rounded-xl border px-4 py-3 outline-none focus:ring-2 ${
          errors[name]
            ? 'border-farm-crit focus:ring-farm-crit'
            : 'border-gray-300 focus:ring-farm-accent'
        }`}
        {...props}
      />
      {errors[name] && (
        <p className="mt-1.5 text-sm font-medium text-farm-crit">{errors[name]}</p>
      )}
    </div>
  );

  return (
    <div className="flex min-h-screen w-screen bg-gradient-to-br from-slate-900 via-farm-accent-deep to-slate-800">
      {/* Left panel — the picture */}
      <div className="relative hidden flex-1 overflow-hidden lg:block">
        <div className="absolute top-6 left-6 z-10">
          <button
            onClick={() => navigate('/')}
            aria-label="Back to sign in"
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
        <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/20 to-transparent" />
        <div className="absolute bottom-10 left-10 right-10 text-white">
          <p className="font-display text-4xl leading-tight">
            Start recording
            <br />
            this morning.
          </p>
          <p className="mt-4 text-sm tracking-[0.18em] text-white/70 uppercase">
            {BRAND_TAGLINE}
          </p>
        </div>
      </div>

      {/* Right panel — the form */}
      <div className="flex flex-1 items-center justify-center bg-white py-10">
        <div className="w-full max-w-md p-8">
          <div className="mb-8">
            <img src="/logo.png" alt="rabbitfarmers" className="mb-6 h-36 w-auto" />
            <h1 className="mb-2 text-3xl font-bold text-gray-900">Create your farm</h1>
            <p className="text-gray-600">
              Free, and it stays free. No card, nothing to expire.
            </p>
          </div>

          <form onSubmit={submit} className="space-y-5">
            {field('farm_name', 'Farm name', {
              placeholder: 'Sunrise Rabbitry',
              required: true,
              autoComplete: 'organization',
            })}
            {field('full_name', 'Your name', {
              placeholder: 'Anil Naik',
              required: true,
              autoComplete: 'name',
            })}
            {field('email', 'Email address', {
              type: 'email',
              placeholder: 'you@example.com',
              required: true,
              autoComplete: 'email',
            })}
            {field('phone', 'Phone', {
              type: 'tel',
              placeholder: '+91 98220 12345',
              required: true,
              autoComplete: 'tel',
            })}

            <div>
              <label htmlFor="password" className="mb-2 block text-sm font-medium text-gray-700">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={onChange}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                  aria-invalid={!!errors.password}
                  required
                  className={`w-full rounded-xl border px-4 py-3 pr-12 outline-none focus:ring-2 ${
                    errors.password
                      ? 'border-farm-crit focus:ring-farm-crit'
                      : 'border-gray-300 focus:ring-farm-accent'
                  }`}
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
              {errors.password && (
                <p className="mt-1.5 text-sm font-medium text-farm-crit">{errors.password}</p>
              )}
            </div>

            <div>
              <p className="mb-3 text-sm font-medium text-gray-700">Where is the farm?</p>
              <div className="space-y-4">
                {field('address_line', 'Address', {
                  placeholder: 'Survey no., village', required: true,
                })}
                <div className="grid grid-cols-2 gap-4">
                  {field('city', 'Town', { placeholder: 'Margao', required: true })}
                  {field('state', 'State', { placeholder: 'Goa', required: true })}
                </div>
                {field('pincode', 'PIN code', {
                  placeholder: '403709', inputMode: 'numeric', required: true,
                })}
              </div>
            </div>

            {message && (
              <p
                role="alert"
                className="rounded-xl bg-farm-crit-soft px-4 py-3 text-sm font-medium text-farm-crit"
              >
                {message}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-farm-accent px-4 py-3 font-medium text-white transition-colors hover:bg-farm-accent-deep disabled:opacity-60"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy ? 'Creating your farm…' : 'Create my farm'}
            </button>

            <p className="text-center text-sm text-gray-600">
              Already have a farm?{' '}
              <button
                type="button"
                onClick={() => navigate('/')}
                className="font-medium text-farm-accent hover:underline"
              >
                Sign in
              </button>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
