import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthGuard } from '@/features/auth/guards';
import { Layout } from '@/components/shared';
import { LoginPage } from '@/features/auth/pages';
import { DashboardPage } from '@/features/reports/pages';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Placeholder components for routes not yet implemented
const ComingSoon = () => (
  <div className="flex items-center justify-center min-h-screen">
    <div className="text-center">
      <h1 className="text-4xl font-bold text-gray-900 mb-4">Coming Soon</h1>
      <p className="text-gray-600">This module is under development.</p>
    </div>
  </div>
);

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginPage />} />
          
          {/* Protected routes */}
          <Route
            path="/dashboard"
            element={
              <AuthGuard>
                <Layout>
                  <DashboardPage />
                </Layout>
              </AuthGuard>
            }
          />
          
          {/* Placeholder routes for future modules */}
          <Route
            path="/customers"
            element={
              <AuthGuard>
                <Layout>
                  <ComingSoon />
                </Layout>
              </AuthGuard>
            }
          />
          <Route
            path="/products"
            element={
              <AuthGuard>
                <Layout>
                  <ComingSoon />
                </Layout>
              </AuthGuard>
            }
          />
          <Route
            path="/sales/*"
            element={
              <AuthGuard>
                <Layout>
                  <ComingSoon />
                </Layout>
              </AuthGuard>
            }
          />
          <Route
            path="/purchases/*"
            element={
              <AuthGuard>
                <Layout>
                  <ComingSoon />
                </Layout>
              </AuthGuard>
            }
          />
          <Route
            path="/payments/*"
            element={
              <AuthGuard>
                <Layout>
                  <ComingSoon />
                </Layout>
              </AuthGuard>
            }
          />
          <Route
            path="/reports"
            element={
              <AuthGuard>
                <Layout>
                  <ComingSoon />
                </Layout>
              </AuthGuard>
            }
          />
          <Route
            path="/settings"
            element={
              <AuthGuard>
                <Layout>
                  <ComingSoon />
                </Layout>
              </AuthGuard>
            }
          />
          
          {/* Redirect root to dashboard */}
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          
          {/* 404 route */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
