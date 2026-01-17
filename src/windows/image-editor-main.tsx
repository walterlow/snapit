import React from 'react';
import ReactDOM from 'react-dom/client';
import ImageEditorWindow from './ImageEditorWindow';
import '../styles.css';
import { initializeLogging } from '../utils/logger';
import { Toaster } from 'sonner';

// Initialize logging
initializeLogging().catch(console.error);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ImageEditorWindow />
    <Toaster
      position="bottom-right"
      toastOptions={{
        className: 'glass-toast',
        duration: 3000,
      }}
    />
  </React.StrictMode>
);
