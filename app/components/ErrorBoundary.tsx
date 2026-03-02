import { Component, type ReactNode } from 'react';
import { Alert, AlertTitle, AlertDescription } from '~/components/ui/alert';
import { AlertCircle } from 'lucide-react';

type Props = { children: ReactNode; fallback?: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return this.props.fallback ?? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{this.state.error.message}</AlertDescription>
        </Alert>
      );
    }
    return this.props.children;
  }
}
