import React from 'react';
import ReactDOM from 'react-dom/client';
import DcompToolbarWindow from './DcompToolbarWindow';
import '../styles.css';
import { initializeLogging } from '../utils/logger';

// Initialize logging
initializeLogging().catch(console.error);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <DcompToolbarWindow />
  </React.StrictMode>
);
