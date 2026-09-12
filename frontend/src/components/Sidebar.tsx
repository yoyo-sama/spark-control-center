import { AppWindow, Container, Cpu, Gauge, LayoutDashboard, Moon, Sun } from 'lucide-react';
import { useTheme } from '../lib/theme';
import type { View } from '../types';

interface Props {
  currentView: View;
  onViewChange: (view: View) => void;
  machineLabel: string;
  machineSubtitle: string;
}

export default function Sidebar({ currentView, onViewChange, machineLabel, machineSubtitle }: Props) {
  const { isDark, toggle } = useTheme();

  return (
    <aside className="w-60 shrink-0 bg-surface border-r border-line flex flex-col">
      <div className="h-16 flex items-center gap-3 px-5 border-b border-line">
        <div className="w-8 h-8 rounded-lg bg-accent text-accent-fg flex items-center justify-center shrink-0">
          <Container size={17} strokeWidth={2.2} />
        </div>
        <div className="min-w-0">
          <h1 className="text-sm font-semibold tracking-tight leading-tight">Spark Control Center</h1>
          <p className="text-[11px] text-muted leading-tight">
            {machineLabel} {machineSubtitle}
          </p>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-1" aria-label="Main navigation">
        <button
          onClick={() => onViewChange('gb10')}
          className={`w-full flex items-center gap-2.5 px-3 h-9 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20 ${
            currentView === 'gb10'
              ? 'bg-hover text-fg'
              : 'text-muted hover:text-fg hover:bg-hover'
          }`}
        >
          <Cpu size={16} strokeWidth={2} />
          {machineLabel}
        </button>
        <button
          onClick={() => onViewChange('apps')}
          className={`w-full flex items-center gap-2.5 px-3 h-9 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20 ${
            currentView === 'apps'
              ? 'bg-hover text-fg'
              : 'text-muted hover:text-fg hover:bg-hover'
          }`}
        >
          <AppWindow size={16} strokeWidth={2} />
          Apps
        </button>
        <button
          onClick={() => onViewChange('dashboard')}
          className={`w-full flex items-center gap-2.5 px-3 h-9 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20 ${
            currentView === 'dashboard'
              ? 'bg-hover text-fg'
              : 'text-muted hover:text-fg hover:bg-hover'
          }`}
        >
          <LayoutDashboard size={16} strokeWidth={2} />
          Containers
        </button>
        <button
          onClick={() => onViewChange('dgx')}
          className={`w-full flex items-center gap-2.5 px-3 h-9 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20 ${
            currentView === 'dgx'
              ? 'bg-hover text-fg'
              : 'text-muted hover:text-fg hover:bg-hover'
          }`}
        >
          <Gauge size={16} strokeWidth={2} />
          DGX Dashboard
        </button>
      </nav>

      <div className="p-3 border-t border-line">
        <button
          onClick={toggle}
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          className="w-full flex items-center gap-2.5 px-3 h-9 rounded-lg text-sm font-medium text-muted hover:text-fg hover:bg-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20"
        >
          {isDark ? <Sun size={16} strokeWidth={2} /> : <Moon size={16} strokeWidth={2} />}
          {isDark ? 'Light theme' : 'Dark theme'}
        </button>
      </div>
    </aside>
  );
}
