import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '@/stores';

interface PermissionGuardProps {
  children: React.ReactNode;
  module: string;
  action?: string;
}

export function PermissionGuard({ children, module, action = 'read' }: PermissionGuardProps) {
  const { user } = useAuthStore();

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // Admin has all permissions
  if (user.role === 'admin') {
    return <>{children}</>;
  }

  // Check permissions
  const permission = user.permissions.find(p => p.module === module);
  
  if (!permission || !permission.actions.includes(action)) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">403</h1>
          <p className="text-gray-600">You don't have permission to access this page.</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
