import { createRoot } from 'react-dom/client';
import { Component, type ReactNode } from 'react';
import { App } from './App';
// fonts are bundled (the app runs on a LAN without internet); browsers only download the one in use
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource-variable/figtree';
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/inter';
import '@fontsource-variable/manrope';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/outfit';
import '@fontsource-variable/nunito';
import '@fontsource-variable/lexend';
import '@fontsource-variable/source-sans-3';
import './styles.css';

/** Shows the error instead of a blank page if rendering ever throws. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="auth-wrap">
        <div className="card auth">
          <h1>Something Went Wrong</h1>
          <p className="muted">The page hit an error. Reloading usually fixes it; your data is safe on the server.</p>
          <code className="block">{this.state.error.message}</code>
          <button className="primary" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>);
