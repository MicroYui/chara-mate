import { Component, type ErrorInfo, type ReactNode } from "react";

import styles from "./RendererErrorBoundary.module.css";

interface RendererErrorBoundaryProps {
  readonly children: ReactNode;
}

interface RendererErrorBoundaryState {
  readonly error?: Error;
}

export class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  override state: RendererErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): RendererErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("CHARAMATE_RENDERER_ERROR", error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className={styles["recovery"]}>
        <div>
          <p>界面恢复</p>
          <h1>CharaMate 的界面遇到了问题</h1>
          <span>
            对话和运行状态保存在本地。你可以先重试界面；如果问题仍在，再重新载入应用。
          </span>
          <details>
            <summary>错误详情</summary>
            <code>{this.state.error.message}</code>
          </details>
          <nav aria-label="界面恢复操作">
            <button type="button" onClick={() => this.setState({})}>
              重试界面
            </button>
            <button type="button" onClick={() => window.location.reload()}>
              重新载入应用
            </button>
          </nav>
        </div>
      </main>
    );
  }
}
