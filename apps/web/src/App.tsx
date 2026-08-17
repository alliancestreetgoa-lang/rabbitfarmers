import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LoginPage } from '@/components/ui/sign-in-page';
import { SignUpPage } from '@/components/ui/sign-up-page';

/**
 * Sign in and sign up are both real. /dashboard is still a placeholder so the
 * two of them land somewhere honest instead of a blank screen — the dashboard is
 * the next piece of work.
 */
function Placeholder({ title }: { title: string }) {
  /*
   * The web dashboard is not built yet, but the PRODUCT is — the full app
   * (herd, breeding, team, attendance, all of it) is the Expo web build. In dev
   * that is the one-origin site localhost.sh serves; deployed, it is this same
   * origin's root, where netlify.toml publishes it. Stranding a farmer who just
   * signed up on a "not built yet" page, with a working app one URL away, is
   * how the first user of the day concludes the whole thing is broken.
   */
  const fullApp = import.meta.env.DEV ? 'http://localhost:8080' : '/';
  return (
    <div className="flex h-screen items-center justify-center bg-farm-ground">
      <div className="max-w-md p-8 text-center">
        <p className="font-display text-3xl">{title}</p>
        <p className="mt-3 text-sm text-farm-muted">
          The web dashboard is still being built. Your farm, your rabbits and
          your team all live in the full app — sign in there with the same
          email and password.
        </p>
        <a
          href={fullApp}
          className="mt-6 inline-block rounded-xl bg-farm-accent px-5 py-3 text-sm font-semibold text-white"
        >
          Open the full app →
        </a>
        <div className="mt-4">
          <a href="/" className="text-sm font-semibold text-farm-accent">
            ← Back to sign in
          </a>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="/dashboard" element={<Placeholder title="Dashboard" />} />
        <Route path="/signup" element={<SignUpPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
