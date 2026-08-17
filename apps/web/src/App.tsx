import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LoginPage } from '@/components/ui/sign-in-page';
import { SignUpPage } from '@/components/ui/sign-up-page';

/**
 * Sign in and sign up are both real. /dashboard is still a placeholder so the
 * two of them land somewhere honest instead of a blank screen — the dashboard is
 * the next piece of work.
 */
function Placeholder({ title }: { title: string }) {
  return (
    <div className="flex h-screen items-center justify-center bg-farm-ground">
      <div className="max-w-md p-8 text-center">
        <p className="font-display text-3xl">{title}</p>
        <p className="mt-3 text-sm text-farm-muted">
          Not built yet. Sign-in works — this is where it lands.
        </p>
        <a href="/" className="mt-6 inline-block text-sm font-semibold text-farm-accent">
          ← Back to sign in
        </a>
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
