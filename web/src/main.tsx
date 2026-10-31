import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { applyTheme, savedTheme } from "./lib/theme";
import "./styles.css";

// The saved theme goes on before the first paint.
applyTheme(savedTheme());

/** A render error anywhere would otherwise leave a blank page: say so, and offer the way out. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error : new Error(String(error)) }; }
  componentDidCatch(error: unknown, info: React.ErrorInfo) { console.error(error, info.componentStack); }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="login">
        <div className="login-box" role="alert">
          <h1 className="login-name">Something broke on this page</h1>
          <p className="quiet">Reloading usually fixes it. If it keeps happening, the message below says where to look.</p>
          <pre className="code">{error.message || String(error)}</pre>
          <button type="button" className="btn primary block" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
