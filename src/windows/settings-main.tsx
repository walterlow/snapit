import React from 'react';
import ReactDOM from 'react-dom/client';
import SettingsWindow from './SettingsWindow';
import '../styles.css';
import { initializeLogging } from '../utils/logger';

// Initialize logging
initializeLogging().catch(console.error);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <SettingsWindow />
  </React.StrictMode>
);
