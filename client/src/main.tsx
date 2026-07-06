import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

// HashRouter would also work for Vercel's static deploy, but BrowserRouter
// gives us real /case-property/:item_id URLs that copy-paste cleanly.  The
// server has a `/:*` catch-all that serves index.html so deep links work.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
