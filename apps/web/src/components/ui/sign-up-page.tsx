'use client';

import { useState } from 'react';
import { Eye, EyeOff, ArrowLeft, Loader2, ChevronDown } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { BRAND_IMAGE, BRAND_TAGLINE } from '@/lib/brand';

/**
 * Create a farm. Free, instant, no card, no verification step.
 *
 * FIVE FIELDS, not nine.
 *
 * The phone app asks for farm name, your name, email, phone, password, address,
 * town, state and PIN. Only the first five are required: validateSignup in
 * apps/api/src/auth.js defaults address_line, city, state and pincode to null and
 * never rejects a missing one. Four of the nine fields were being demanded by the
 * form and ignored by the server.
 *
 * That matters more than it sounds. This is the screen between a farmer hearing
 * about the product and using it, the product is free specifically so that as
 * many farms as possible get that far, and every field is somewhere to stop. So
 * the address is here — it is genuinely useful, and a farm with one is easier to
 * support — but it is folded away and plainly optional.
 *
 * Errors are rendered per field. /auth/signup answers 400 with
 * `detail: { field: message }` and 409 with `detail: { field }` for a duplicate,
 * and that 409 distinction exists because a farmer whose PHONE was taken used to
 * be told their EMAIL was — so they would change the email, try again, and read
 * the same sentence, with nothing pointing at the field that was actually wrong.
 */

type Errors = Record<string, string>;

const REQUIRED = ['farm_name', 'full_name', 'email', 'phone', 'password'] as const;

export function SignUpPage() {
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  const [showAddress, setShowAddress] = useState(false);
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

      window.localStorage.setItem('rf.session', JSON.stringify(body));
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
        {!REQUIRED.includes(name as (typeof REQUIRED)[number]) && (
          <span className="ml-1 font-normal text-gray-400">optional</span>
        )}
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
            <p className="mb-6 font-display text-2xl">
              <span className="text-farm-accent">rabbit</span>
              <span className="text-[#5a3a22]">farmers</span>
            </p>
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

            {/* Folded away because the server does not need any of it. */}
            <div className="rounded-xl border border-gray-200">
              <button
                type="button"
                onClick={() => setShowAddress(!showAddress)}
                aria-expanded={showAddress}
                className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-gray-700"
              >
                <span>
                  Where is the farm?{' '}
                  <span className="font-normal text-gray-400">optional</span>
                </span>
                <ChevronDown
                  className={`h-4 w-4 text-gray-500 transition-transform ${
                    showAddress ? 'rotate-180' : ''
                  }`}
                />
              </button>
              {showAddress && (
                <div className="space-y-4 border-t border-gray-200 p-4">
                  {field('address_line', 'Address', { placeholder: 'Survey no., village' })}
                  <div className="grid grid-cols-2 gap-4">
                    {field('city', 'Town', { placeholder: 'Margao' })}
                    {field('state', 'State', { placeholder: 'Goa' })}
                  </div>
                  {field('pincode', 'PIN code', { placeholder: '403709', inputMode: 'numeric' })}
                </div>
              )}
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
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-black px-4 py-3 font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-60"
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
