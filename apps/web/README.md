# ERP Pro - Frontend

A modern, responsive ERP system frontend built with React 18, TypeScript, Tailwind CSS, and Shadcn/ui components.

## Tech Stack

- **React 18** - UI library
- **TypeScript** - Type safety
- **Vite** - Build tool
- **Tailwind CSS** - Styling
- **Shadcn/ui** - Component library
- **Zustand** - State management
- **TanStack Query** - Data fetching
- **React Router** - Routing
- **React Hook Form + Zod** - Form handling & validation

## Project Structure

```
apps/web/src/
├── assets/           # Static files
├── components/       # Reusable components
│   ├── ui/          # Base UI components (Button, Input, Card...)
│   ├── forms/       # Form components
│   ├── tables/      # Table components
│   ├── charts/      # Chart components
│   └── shared/      # Shared layout components
├── features/         # Feature-based modules
│   ├── auth/        # Authentication
│   ├── customers/   # Customer management
│   ├── products/    # Product management
│   ├── sales/       # Sales module
│   ├── purchases/   # Purchases module
│   ├── payments/    # Payments module
│   ├── gst/         # GST compliance
│   ├── reports/     # Reports & analytics
│   └── settings/    # Settings
├── hooks/           # Custom hooks
├── lib/             # Utilities & helpers
├── stores/          # Zustand stores
├── types/           # TypeScript types
├── App.tsx          # Main app component
└── main.tsx         # Entry point
```

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Installation

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

The app will be available at `http://localhost:3000`

### Build

```bash
# Production build
npm run build

# Preview production build
npm run preview
```

## Environment Variables

Create a `.env.local` file in the root directory:

```env
VITE_API_BASE_URL=http://localhost:5000/api/v1
VITE_SOCKET_URL=http://localhost:5000
VITE_APP_NAME=ERP Pro
VITE_ENV=development
```

## Features Implemented

### Foundation Modules
- ✅ Authentication (Login, JWT handling, auto-refresh)
- ✅ Auth Guards (AuthGuard, PermissionGuard)
- ✅ Layout with sidebar navigation
- ✅ Dashboard with KPIs
- ✅ TypeScript types for all entities
- ✅ API client with interceptors
- ✅ Zustand auth store with persistence

### UI Components
- ✅ Button (with variants)
- ✅ Input
- ✅ Card components
- ✅ Responsive layout

## Module Status

| Module | Status |
|--------|--------|
| Auth & Login | ✅ Complete |
| Dashboard | ✅ Complete |
| Customers | 🚧 Placeholder |
| Products | 🚧 Placeholder |
| Sales | 🚧 Placeholder |
| Purchases | 🚧 Placeholder |
| Payments | 🚧 Placeholder |
| GST | 🚧 Placeholder |
| Reports | 🚧 Partial |
| Settings | 🚧 Placeholder |

## Next Steps

1. Install dependencies: `npm install`
2. Implement remaining UI components from Shadcn/ui
3. Build out feature modules following the PRD
4. Connect to backend APIs
5. Add comprehensive testing

## License

Private - All rights reserved
