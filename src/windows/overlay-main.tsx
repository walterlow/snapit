import React from 'react';
import ReactDOM from 'react-dom/client';
import OverlayWindow from './OverlayWindow';
import '../styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <OverlayWindow />
  </React.StrictMode>
);
