import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Loading } from './components/ui';
import { useAuth } from './lib/app';
import { ActionsPage } from './pages/Actions';
import { AdminPage } from './pages/Admin';
import { AssistantPage } from './pages/Assistant';
import { ImportPage } from './pages/Import';
import { LoginPage } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { ReportsPage } from './pages/Reports';
import { RisksPage } from './pages/Risks';
import { TrackerPage } from './pages/Tracker';
import { VacancyPage } from './pages/Vacancy';
import { WorkspacePage } from './pages/Workspace';

export function App() {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="flex h-full items-center justify-center"><Loading /></div>;
  if (!user) return loc.pathname === '/login' ? <LoginPage /> : <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (loc.pathname === '/login') return <Navigate to={(loc.state as any)?.from ?? '/'} replace />;
  // Leaders land on the overview; recruiters land on their own workspace.
  const home = user.role === 'recruiter' ? '/workspace' : '/overview';
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Navigate to={home} replace />} />
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/workspace" element={<WorkspacePage />} />
        <Route path="/tracker" element={<TrackerPage />} />
        <Route path="/vacancies/:id" element={<VacancyPage />} />
        <Route path="/actions" element={<ActionsPage />} />
        <Route path="/risks" element={<RisksPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/assistant" element={<AssistantPage />} />
        <Route path="/import" element={<ImportPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/admin/:tab" element={<AdminPage />} />
        <Route path="*" element={<Navigate to={home} replace />} />
      </Routes>
    </Shell>
  );
}
