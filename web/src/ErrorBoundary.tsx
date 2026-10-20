import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("render error", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="page auth-page">
        <h1>VALET</h1>
        <div className="auth-form">
          <h2>Something broke</h2>
          <p className="muted">{this.state.error.message}</p>
          <button onClick={() => location.reload()}>Reload</button>
        </div>
      </main>
    );
  }
}
