import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LoginPage } from '@/components/ui/sign-in-page';
import { SignUpPage } from '@/components/ui/sign-up-page';
import { DashboardPage } from '@/components/ui/dashboard-page';
import { TodayPage } from '@/pages/today';
import { HerdPage, AnimalPage } from '@/pages/herd';
import { BreedingPage } from '@/pages/breeding';
import { LittersPage } from '@/pages/litters';
import { HealthPage } from '@/pages/health';
import { TeamPage, TeamPersonPage } from '@/pages/team';
import { AttendancePage } from '@/pages/attendance';
import { SickPage, RabbitHealthPage } from '@/pages/sick';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/dashboard/today" element={<TodayPage />} />
        <Route path="/dashboard/herd" element={<HerdPage />} />
        <Route path="/dashboard/herd/:animalId" element={<AnimalPage />} />
        <Route path="/dashboard/breeding" element={<BreedingPage />} />
        <Route path="/dashboard/litters" element={<LittersPage />} />
        <Route path="/dashboard/health" element={<HealthPage />} />
        <Route path="/dashboard/sick" element={<SickPage />} />
        <Route path="/dashboard/sick/:animalId" element={<RabbitHealthPage />} />
        <Route path="/dashboard/team" element={<TeamPage />} />
        <Route path="/dashboard/team/:personId" element={<TeamPersonPage />} />
        <Route path="/dashboard/attendance" element={<AttendancePage />} />
        <Route path="/signup" element={<SignUpPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
