import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LoginPage } from './routes/LoginPage';
import { DashboardPage } from './routes/DashboardPage';
import { RunsPage } from './routes/RunsPage';
import { RunDetailPage } from './routes/RunDetailPage';
import { HistoryPage } from './routes/HistoryPage';
import { ReplaysPage } from './routes/ReplaysPage';
import { SettingsPage } from './routes/SettingsPage';
import { BillingPage } from './routes/BillingPage';

export default function App() {
  return (
    <Routes>
      {/* Unauthenticated */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/confirm" element={<LoginPage />} />

      {/* Authenticated shell */}
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:runId" element={<RunDetailPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/replays" element={<ReplaysPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/billing" element={<BillingPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
