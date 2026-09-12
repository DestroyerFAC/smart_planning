import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PlanningProvider } from './ui/store';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Element #root introuvable');

createRoot(container).render(
  <StrictMode>
    <PlanningProvider>
      <App />
    </PlanningProvider>
  </StrictMode>,
);
