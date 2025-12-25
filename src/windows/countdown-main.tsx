import React from 'react';
import ReactDOM from 'react-dom/client';
import CountdownWindow from './CountdownWindow';
import '../styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <CountdownWindow />
  </React.StrictMode>
);
