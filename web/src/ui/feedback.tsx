import { useRouteError } from "react-router";

export function ErrorView() {
  const err = useRouteError();
  const msg = err instanceof Error ? err.message : String(err);
  return (
    <div className="card error">
      <h2>Something went wrong</h2>
      <p>{msg}</p>
    </div>
  );
}

/** An action's error, shown above the form that caused it. */
export function Banner({ error }: { error?: string }) {
  if (!error) return null;
  return <div className="banner error">{error}</div>;
}
