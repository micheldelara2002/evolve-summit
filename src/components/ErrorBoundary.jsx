import React from "react";
import { Button } from "@/components/ui/button";

/**
 * Error Boundary global — captura erros de runtime que causariam tela branca.
 * Permite ao usuário recarregar ou tentar novamente sem perder o contexto do app.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 flex items-center justify-center bg-background p-4">
          <div className="text-center max-w-sm space-y-4">
            <div className="w-14 h-14 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
              <svg className="w-7 h-7 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
            </div>
            <div>
              <h2 className="font-heading font-bold text-lg">Algo deu errado</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Ocorreu um erro inesperado. Tente recarregar a página.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Button onClick={() => window.location.reload()}>
                Recarregar página
              </Button>
              <Button variant="outline" onClick={this.handleReset}>
                Tentar novamente
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}