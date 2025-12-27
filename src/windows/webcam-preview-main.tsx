import React from 'react';
import ReactDOM from 'react-dom/client';
import WebcamPreviewWindow from './WebcamPreviewWindow';
import '../styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <WebcamPreviewWindow />
  </React.StrictMode>
);
