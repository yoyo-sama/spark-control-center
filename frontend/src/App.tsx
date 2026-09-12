import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Rocket } from 'lucide-react';
import Sidebar from './components/Sidebar';
import Dashboard from './components/Dashboard';
import ContainerDetail from './components/ContainerDetail';
import DgxDashboard from './components/DgxDashboard';
import Gb10 from './components/Gb10';
import DeployModal from './components/DeployModal';
import DeployLog from './components/DeployLog';
import ConfirmModal from './components/ConfirmModal';
import type { Container, View } from './types';

interface DeployForm {
  repo: string;
  branch: string;
  name: string;
  ports: { hostPort: string; containerPort: string; protocol: string }[];
  env: { key: string; value: string }[];
}

const API_BASE = '/api';

function App() {
  const [containers, setContainers] = useState<Container[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [activeDeployId, setActiveDeployId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<View>('gb10');
  const [selectedContainerId, setSelectedContainerId] = useState<string | null>(null);

  const fetchContainers = async () => {
    try {
      const response = await fetch(`${API_BASE}/containers`);
      if (!response.ok) throw new Error('Failed to fetch containers');
      const data = await response.json();
      setContainers(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchContainers();
    setRefreshing(false);
  };

  const executeAction = async (id: string, action: 'start' | 'stop' | 'restart' | 'delete') => {
    if (action === 'delete') {
      return fetch(`${API_BASE}/containers/${id}`, { method: 'DELETE' });
    }
    return fetch(`${API_BASE}/containers/${id}/${action}`, { method: 'POST' });
  };

  useEffect(() => {
    fetchContainers();
    const interval = setInterval(fetchContainers, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleAction = async (id: string, action: 'start' | 'stop' | 'restart' | 'delete') => {
    try {
      const response = await executeAction(id, action);
      if (!response.ok) throw new Error('Action failed');
      if (action === 'delete') {
        setContainers((prev) => prev.filter((c) => c.id !== id));
      } else {
        fetchContainers();
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error performing action');
    }
  };

  const handleDelete = (id: string) => {
    setDeleteConfirmId(id);
  };

  const handleContainerSelect = (id: string) => {
    setSelectedContainerId(id);
    setCurrentView('container-detail');
  };

  const handleBack = () => {
    setCurrentView('dashboard');
    setSelectedContainerId(null);
  };

  const handleDeploy = async (form: DeployForm) => {
    setDeploying(true);
    try {
      const cleanPorts = form.ports
        .filter((p) => p.containerPort)
        .map((p) => ({
          containerPort: parseInt(p.containerPort, 10),
          ...(p.hostPort ? { hostPort: parseInt(p.hostPort, 10) } : {}),
          protocol: p.protocol,
        }));
      const cleanEnv = Object.fromEntries(form.env.filter((e) => e.key).map((e) => [e.key, e.value]));

      const response = await fetch(`${API_BASE}/deploy/github`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: form.repo,
          branch: form.branch || undefined,
          name: form.name || undefined,
          ports: cleanPorts,
          env: cleanEnv,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Deploy failed');
      setShowDeployModal(false);
      setActiveDeployId(data.deployId);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Deploy failed');
    } finally {
      setDeploying(false);
    }
  };

  const handleDeployDone = () => {
    setActiveDeployId(null);
    fetchContainers();
  };

  const headerTitle =
    currentView === 'gb10'
      ? 'GB10'
      : currentView === 'dashboard'
        ? 'Containers'
        : currentView === 'dgx'
          ? 'DGX Dashboard'
          : containers.find((c) => c.id === selectedContainerId)?.name ?? 'Container detail';

  return (
    <div className="flex h-screen bg-base text-fg font-sans">
      <Sidebar currentView={currentView} onViewChange={setCurrentView} />

      <main className="flex-1 overflow-y-auto flex flex-col">
        <header className="sticky top-0 z-40 h-16 shrink-0 px-6 border-b border-line bg-base/80 backdrop-blur flex justify-between items-center">
          <h1 className="text-base font-semibold tracking-tight">{headerTitle}</h1>
          <div className="flex gap-2.5 items-center">
            {currentView === 'gb10' || currentView === 'dgx' ? null : (
              <button
                onClick={() => setShowDeployModal(true)}
                className="px-3.5 h-9 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 transition-opacity inline-flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/30"
              >
                <Rocket size={14} strokeWidth={2.2} />
                Deploy
              </button>
            )}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="px-3.5 h-9 rounded-lg border border-line text-sm font-medium hover:bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/20"
            >
              {refreshing ? (
                <Loader2 size={14} strokeWidth={2} className="animate-spin" />
              ) : (
                <RefreshCw size={14} strokeWidth={2} />
              )}
              Refresh
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="m-6 p-4 rounded-lg border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
              {error}
            </div>
          )}

          {currentView === 'gb10' && <Gb10 />}

          {currentView === 'dashboard' && (
            <Dashboard
              containers={containers}
              onContainerSelect={handleContainerSelect}
              onAction={handleAction}
            />
          )}

          {currentView === 'dgx' && <DgxDashboard />}

          {currentView === 'container-detail' && selectedContainerId && (
            <ContainerDetail
              containerId={selectedContainerId}
              onBack={handleBack}
              onAction={handleAction}
              onDelete={handleDelete}
            />
          )}
        </div>
      </main>

      {showDeployModal && (
        <DeployModal onDeploy={handleDeploy} onClose={() => setShowDeployModal(false)} loading={deploying} />
      )}

      {activeDeployId && (
        <DeployLog deployId={activeDeployId} onDone={handleDeployDone} />
      )}

      {deleteConfirmId && (
        <ConfirmModal
          title="Delete container?"
          message={`Are you sure you want to delete "${containers.find((c) => c.id === deleteConfirmId)?.name || deleteConfirmId.substring(0, 12)}"? This action cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={() => {
            handleAction(deleteConfirmId, 'delete');
            setDeleteConfirmId(null);
          }}
          onCancel={() => setDeleteConfirmId(null)}
        />
      )}
    </div>
  );
}

export default App;
